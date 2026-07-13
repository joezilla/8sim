import type { IBus } from '../../interfaces/IBus.js';
import { u8 } from '../../util/bits.js';
import {
  type GeometrySpec,
  type MdcDioDisk,
  MdcDioRangeError,
  SECTOR_SIZE,
} from './MdcDioDisk.js';

/**
 * Command-string interpreter for the IMSAI MDC-DIO firmware model (Story 5.11).
 *
 * A Command String is a 4-7 byte descriptor the guest builds in main RAM and
 * the firmware executes when a Byte Command 0 (execute-via-pointer) arrives:
 *
 *   Byte1  command<<4 | drive-select mask (exactly one of bits 0-3)
 *   Byte2  status (firmware writes the result here; 0 while pending)
 *   Byte3  track high — must be 0
 *   Byte4  track
 *   Byte5  sector (1-based)                      — cmd 1/2/4/5
 *   Byte6  data-buffer address low               — cmd 1/2
 *   Byte7  data-buffer address high (not 0xE0)   — cmd 1/2
 */

/** Status byte codes. Bit 7 set = error; 0x01 = clean success. */
export enum MdcStatus {
  SUCCESS = 0x01,
  DELETED = 0x97, // deleted-data mark seen; data still transferred, not an abort
  ERR_NO_DRIVE = 0xc2,
  ERR_MULTI_DRIVE = 0xc3,
  ERR_BAD_CMD = 0xc4,
  ERR_TRACK = 0xc5,
  ERR_SECTOR = 0xc6,
  ERR_BUFFER = 0xc7,
  ERR_NOT_READY = 0xa1,
  ERR_HW_WP = 0xa2,
  ERR_SW_WP = 0xa3,
  ERR_INOPERABLE = 0x91,
  ERR_SECTOR_NOT_FOUND = 0x93,
}

/** Command-string command numbers (Byte1 high nibble). */
export enum MdcCommand {
  WRITE = 1,
  READ = 2,
  FORMAT = 3,
  VERIFY = 4,
  WRITE_DELETED = 5,
}

export interface CommandString {
  readonly command: number; // Byte1 high nibble
  readonly driveMask: number; // Byte1 low nibble
  readonly trackHigh: number; // Byte3
  readonly track: number; // Byte4
  readonly sector: number; // Byte5
  readonly bufferAddr: number; // Byte6/7
}

/** Read the 7 raw command-string bytes from main memory. */
export function parseCommandString(bus: IBus, addr: number): CommandString {
  const b = (n: number): number => bus.read((addr + n) & 0xffff) & 0xff;
  const b1 = b(0);
  return {
    command: (b1 >> 4) & 0x0f,
    driveMask: b1 & 0x0f,
    trackHigh: b(2),
    track: b(3),
    sector: b(4),
    bufferAddr: b(5) | (b(6) << 8),
  };
}

/** Everything the interpreter needs from the card, without coupling to it. */
export interface CommandContext {
  readonly bus: IBus;
  /** Address of the Command String in main RAM. */
  readonly addr: number;
  /** Geometry for the entry point used (standard vs mini). */
  readonly geometry: GeometrySpec;
  getDisk(drive: number): MdcDioDisk | undefined;
  isSoftwareWriteProtected(drive: number): boolean;
  isHardwareWriteProtected(drive: number): boolean;
}

/** Number of set bits in the low nibble. */
function popcount4(mask: number): number {
  let n = 0;
  for (let i = 0; i < 4; i++) if ((mask & (1 << i)) !== 0) n++;
  return n;
}

function singleDrive(mask: number): number {
  for (let i = 0; i < 4; i++) if (mask === (1 << i)) return i;
  return -1;
}

const isWrite = (cmd: number): boolean =>
  cmd === MdcCommand.WRITE || cmd === MdcCommand.WRITE_DELETED;
const needsSector = (cmd: number): boolean => cmd !== MdcCommand.FORMAT;
const needsBuffer = (cmd: number): boolean =>
  cmd === MdcCommand.WRITE || cmd === MdcCommand.READ;

/**
 * Validate and execute a Command String, returning the resulting status byte.
 * Writes the status into Byte2 of the string as a side effect (matching the
 * firmware, which sets the status word and also returns it in A). All disk
 * access is awaited, so an async backend completes before the status is set.
 */
export async function executeCommand(ctx: CommandContext): Promise<number> {
  const cs = parseCommandString(ctx.bus, ctx.addr);
  const status = await run(ctx, cs);
  ctx.bus.write((ctx.addr + 1) & 0xffff, status); // Byte2 = status
  return status;
}

async function run(ctx: CommandContext, cs: CommandString): Promise<number> {
  // Drive selection (C2/C3).
  const drives = popcount4(cs.driveMask);
  if (drives === 0) return MdcStatus.ERR_NO_DRIVE;
  if (drives > 1) return MdcStatus.ERR_MULTI_DRIVE;
  const drive = singleDrive(cs.driveMask);

  // Command number (C4).
  if (cs.command < 1 || cs.command > 5) return MdcStatus.ERR_BAD_CMD;

  // Track (C5): Byte3 must be 0, Byte4 in range.
  if (cs.trackHigh !== 0 || cs.track >= ctx.geometry.tracks) return MdcStatus.ERR_TRACK;

  // Sector (C6).
  if (needsSector(cs.command) && (cs.sector < 1 || cs.sector > ctx.geometry.sectors)) {
    return MdcStatus.ERR_SECTOR;
  }

  // Buffer (C7): high byte 0xE0 would collide with the DIO window.
  if (needsBuffer(cs.command) && ((cs.bufferAddr >> 8) & 0xff) === 0xe0) {
    return MdcStatus.ERR_BUFFER;
  }

  const disk = ctx.getDisk(drive);
  if (!disk) return MdcStatus.ERR_NOT_READY;

  // Write-protect (A2/A3) for write-class operations.
  if (isWrite(cs.command)) {
    if (ctx.isHardwareWriteProtected(drive)) return MdcStatus.ERR_HW_WP;
    if (ctx.isSoftwareWriteProtected(drive)) return MdcStatus.ERR_SW_WP;
  }

  try {
    return await execute(ctx, cs, disk);
  } catch (e) {
    if (e instanceof MdcDioRangeError) {
      return e.kind === 'track' ? MdcStatus.ERR_TRACK : MdcStatus.ERR_SECTOR;
    }
    // Any other backend failure (e.g. server not ready) is a hardware error.
    return MdcStatus.ERR_INOPERABLE;
  }
}

async function execute(
  ctx: CommandContext,
  cs: CommandString,
  disk: MdcDioDisk,
): Promise<number> {
  switch (cs.command) {
    case MdcCommand.READ: {
      const data = await disk.readSector(cs.track, cs.sector);
      for (let i = 0; i < SECTOR_SIZE; i++) {
        ctx.bus.write((cs.bufferAddr + i) & 0xffff, u8(data[i] ?? 0));
      }
      return disk.isDeleted(cs.track, cs.sector) ? MdcStatus.DELETED : MdcStatus.SUCCESS;
    }
    case MdcCommand.WRITE: {
      const data = new Uint8Array(SECTOR_SIZE);
      for (let i = 0; i < SECTOR_SIZE; i++) {
        data[i] = ctx.bus.read((cs.bufferAddr + i) & 0xffff) & 0xff;
      }
      await disk.writeSector(cs.track, cs.sector, data);
      return MdcStatus.SUCCESS;
    }
    case MdcCommand.FORMAT: {
      await disk.formatTrack(cs.track);
      return MdcStatus.SUCCESS;
    }
    case MdcCommand.VERIFY: {
      await disk.readSector(cs.track, cs.sector); // confirm the sector is readable
      return disk.isDeleted(cs.track, cs.sector) ? MdcStatus.DELETED : MdcStatus.SUCCESS;
    }
    case MdcCommand.WRITE_DELETED: {
      disk.setDeleted(cs.track, cs.sector, true);
      return MdcStatus.SUCCESS;
    }
    default:
      return MdcStatus.ERR_BAD_CMD;
  }
}
