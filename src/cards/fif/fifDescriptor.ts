import type { IBus } from '../../interfaces/IBus.js';
import { u8 } from '../../util/bits.js';
import { type FloppyDisk, FloppyRangeError, SECTOR_SIZE } from '../floppy/FloppyDisk.js';

/**
 * IMSAI FIF disk-descriptor interpreter (Story 5.12). Matched byte-for-byte to
 * z80pack's `imsai-fif.c` so the same disk images boot.
 *
 * A "disk descriptor" is a 7-byte structure the host builds in main RAM; the
 * FIF executes it (moving the descriptor, data buffer, and result byte to/from
 * main memory by DMA) when the host issues `OUT 0xFD, 0x0N` (execute pointer N):
 *
 *   B0  command<<4 | unit          (unit = drive-select value 1/2/4/8)
 *   B1  result (host writes 0; controller writes non-zero on completion)
 *   B2  track high / format        (must be 0)
 *   B3  track (0-76)
 *   B4  sector (1-26)
 *   B5  DMA buffer address low
 *   B6  DMA buffer address high
 */

/** Result byte codes (B1). Bit 7 set = error; 0x01 = success. */
export enum FifStatus {
  SUCCESS = 0x01,
  ERR_RESULT_NOT_ZERO = 0xc1, // B1 wasn't 0 when the command was issued
  ERR_NO_DRIVE = 0xc2, // unit == 0
  ERR_MULTI_DRIVE = 0xc3, // unit not one of 1/2/4/8
  ERR_BAD_CMD = 0xc4, // command not 1-4
  ERR_TRACK = 0xc5, // track >= 77
  ERR_SECTOR = 0xc6, // sector < 1 or > 26
  ERR_FORMAT = 0xc8, // B2 (track-hi/format) != 0
  ERR_NOT_READY = 0xa1, // drive not mounted / wrong size
  ERR_HW_WP = 0xa2, // disk is read-only (hardware write-protect)
  ERR_SW_WP = 0xa3, // software write-protect set
  ERR_SEEK = 0x92, // seek failure
  ERR_DATA = 0x93, // read/write transfer error
}

/** Command numbers (B0 high nibble). Only 1-4 are implemented, as in z80pack. */
export enum FifCommand {
  READ_ALL = 0, // raw read — unimplemented (no real software uses it)
  WRITE = 1,
  READ = 2,
  FORMAT = 3,
  VERIFY = 4,
}

/** Descriptor byte offsets (matches z80pack DD_* macros). */
export const DD = {
  UNIT: 0,
  RESULT: 1,
  FORMAT: 2,
  TRACK: 3,
  SECTOR: 4,
  DMAL: 5,
  DMAH: 6,
} as const;

export interface Descriptor {
  readonly command: number; // B0 high nibble
  readonly unit: number; // B0 low nibble (raw drive-select value)
  readonly result: number; // B1 as read
  readonly format: number; // B2
  readonly track: number; // B3
  readonly sector: number; // B4
  readonly bufferAddr: number; // B5/B6
}

/** Read the 7 descriptor bytes from main memory. */
export function parseDescriptor(bus: IBus, addr: number): Descriptor {
  const b = (n: number): number => bus.read((addr + n) & 0xffff) & 0xff;
  const b0 = b(DD.UNIT);
  return {
    command: (b0 >> 4) & 0x0f,
    unit: b0 & 0x0f,
    result: b(DD.RESULT),
    format: b(DD.FORMAT),
    track: b(DD.TRACK),
    sector: b(DD.SECTOR),
    bufferAddr: b(DD.DMAL) | (b(DD.DMAH) << 8),
  };
}

/** Map the drive-select value (1/2/4/8) to a drive index (0-3); -1 if invalid. */
export function unitToDrive(unit: number): number {
  switch (unit) {
    case 1: return 0;
    case 2: return 1;
    case 4: return 2;
    case 8: return 3;
    default: return -1;
  }
}

export interface FifContext {
  readonly bus: IBus;
  /** Address of the descriptor in main RAM. */
  readonly addr: number;
  getDisk(drive: number): FloppyDisk | undefined;
  isSoftwareWriteProtected(drive: number): boolean;
  isHardwareWriteProtected(drive: number): boolean;
}

const isWrite = (cmd: number): boolean => cmd === FifCommand.WRITE;

/**
 * Validate and execute a descriptor, returning the result byte and writing it
 * into B1 (the FIF DMAs the result back to main memory on completion). All disk
 * access is awaited so an async backend finishes before the result is set.
 */
export async function executeDescriptor(ctx: FifContext): Promise<number> {
  const d = parseDescriptor(ctx.bus, ctx.addr);
  const status = await run(ctx, d);
  ctx.bus.write((ctx.addr + DD.RESULT) & 0xffff, status);
  return status;
}

async function run(ctx: FifContext, d: Descriptor): Promise<number> {
  // z80pack requires the result byte to be pre-cleared to 0.
  if (d.result !== 0) return FifStatus.ERR_RESULT_NOT_ZERO;

  // Drive select: exactly one of 1/2/4/8.
  if (d.unit === 0) return FifStatus.ERR_NO_DRIVE;
  const drive = unitToDrive(d.unit);
  if (drive < 0) return FifStatus.ERR_MULTI_DRIVE;

  // Command number 1-4.
  if (d.command < 1 || d.command > 4) return FifStatus.ERR_BAD_CMD;

  // Format byte (B2) must be 0.
  if (d.format !== 0) return FifStatus.ERR_FORMAT;

  const disk = ctx.getDisk(drive);
  if (!disk) return FifStatus.ERR_NOT_READY;

  // Track / sector range against this disk's geometry.
  if (d.track >= disk.geometry.tracks) return FifStatus.ERR_TRACK;
  if (d.command !== FifCommand.FORMAT && (d.sector < 1 || d.sector > disk.geometry.sectors)) {
    return FifStatus.ERR_SECTOR;
  }

  // Write-protect (writes only).
  if (isWrite(d.command)) {
    if (ctx.isHardwareWriteProtected(drive)) return FifStatus.ERR_HW_WP;
    if (ctx.isSoftwareWriteProtected(drive)) return FifStatus.ERR_SW_WP;
  }

  try {
    return await execute(ctx, d, disk);
  } catch (e) {
    if (e instanceof FloppyRangeError) {
      return e.kind === 'track' ? FifStatus.ERR_TRACK : FifStatus.ERR_SECTOR;
    }
    return FifStatus.ERR_DATA;
  }
}

async function execute(ctx: FifContext, d: Descriptor, disk: FloppyDisk): Promise<number> {
  switch (d.command) {
    case FifCommand.READ: {
      const data = await disk.readSector(d.track, d.sector);
      for (let i = 0; i < SECTOR_SIZE; i++) {
        ctx.bus.write((d.bufferAddr + i) & 0xffff, u8(data[i] ?? 0));
      }
      return FifStatus.SUCCESS;
    }
    case FifCommand.WRITE: {
      const data = new Uint8Array(SECTOR_SIZE);
      for (let i = 0; i < SECTOR_SIZE; i++) {
        data[i] = ctx.bus.read((d.bufferAddr + i) & 0xffff) & 0xff;
      }
      await disk.writeSector(d.track, d.sector, data);
      return FifStatus.SUCCESS;
    }
    case FifCommand.FORMAT: {
      await disk.formatTrack(d.track);
      return FifStatus.SUCCESS;
    }
    case FifCommand.VERIFY: {
      await disk.readSector(d.track, d.sector); // confirm the sector reads
      return FifStatus.SUCCESS;
    }
    default:
      return FifStatus.ERR_BAD_CMD;
  }
}
