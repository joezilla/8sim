import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { MemoryMappedIOAdapter } from '../memory/MemoryMappedIOAdapter.js';
import { u8 } from '../util/bits.js';
import {
  buildStubRom,
  STUB_ROM_SIZE,
  TRAP_CMD_STD,
  TRAP_CMD_MINI,
  TRAP_INIT,
  TRAP_BOOT_STD,
  TRAP_BOOT_MINI,
} from './mdcdio/stubRom.js';
import {
  GEOMETRIES,
  type GeometrySpec,
  type MdcDioDisk,
  type MdcDioGeometry,
  SECTOR_SIZE,
} from './mdcdio/MdcDioDisk.js';
import {
  executeCommand,
  MdcStatus,
  type CommandContext,
} from './mdcdio/commandString.js';

const WINDOW_SIZE = 0x1000; // E000-EFFF
const RAM_OFFSET = 0x800; // E800-E8FF within the window
const RAM_SIZE = 0x100;

type DriveKind = 'std' | 'mini';
type PtrPhase = 'none' | 'low' | 'high';

export interface ImsaiMdcDioOptions {
  /** I/O page nibble X for the XE/XF enable/disable ports; default 0xE → 0xEE/0xEF. */
  readonly ioPage?: number;
  /** Base of the 4 KB memory window; 0xE000 on real hardware. */
  readonly baseAddress?: number;
  /** Standard-drive format. Default 'std-sd' (77×26×128, IBM 3740 — the z80pack images). */
  readonly stdGeometry?: 'std-sd' | 'std-dd';
  /**
   * Disk backends keyed by `"kind:drive"`, e.g. `{ 'std:0': disk }`. `kind` is
   * `std` or `mini`; drive is 0-3 (std) / 0-2 (mini).
   */
  readonly disks?: Record<string, MdcDioDisk>;
  /** Whether the window responds at reset (trace L→M default). */
  readonly enabledAtReset?: boolean;
}

/**
 * IMSAI MDC-DIO floppy controller — a firmware-driven, memory-mapped S-100 card
 * (Story 5.11). Unlike register-poked controllers (88-DCDD), software drives it
 * by `CALL`ing firmware entry points in a 4 KB window at E000-EFFF with a
 * command byte in A and reading a status byte back from A.
 *
 * 8sim emulates the firmware's *behavior*, not the 2716 ROM or the 8255/PDS
 * silicon. A synthetic stub ROM (see {@link buildStubRom}) shuttles A through a
 * trap address this card observes; the card runs the command against a pluggable
 * {@link MdcDioDisk} backend and latches the status the stub polls for.
 *
 * The card manages its own memory (the E000-EFFF window), so — like
 * {@link BankRamCard} — it attaches its region directly in `attach()`; the
 * machine must keep RAM clear of E000-EFFF (the engine can't overlap-check
 * card-attached memory). The XE/XF ports are its only I/O-space claim.
 */
export class ImsaiMdcDioCard implements IS100Card {
  readonly id: string;

  private readonly baseAddress: number;
  private readonly portXE: number;
  private readonly portXF: number;
  private readonly stdGeometry: GeometrySpec;
  private readonly stdGeometryName: MdcDioGeometry;
  private readonly enabledAtReset: boolean;

  private readonly stubRom: Uint8Array;
  private readonly ram = new Uint8Array(RAM_SIZE); // E800-E8FF
  private readonly pointers = new Uint16Array(16);
  private readonly disks = new Map<string, MdcDioDisk>();

  private readonly swp: Record<DriveKind, boolean[]> = {
    std: [false, false, false, false],
    mini: [false, false, false],
  };

  // set-pointer (Byte Command 1) 3-write state machine
  private ptrPhase: PtrPhase = 'none';
  private pendingPtr = 0;
  private ptrLow = 0;

  /** Latched status the stub polls: 0 while an operation is pending, non-zero
   * on completion (matching the firmware's "status word is 0 until done"). */
  private status: number = MdcStatus.SUCCESS;
  private operationPending = false;

  private enabled: boolean;
  private bus?: Bus;

  private readonly windowDevice: IIODevice;
  private readonly enableDevice: IIODevice;

  constructor(id = 'mdcdio', opts: ImsaiMdcDioOptions = {}) {
    this.id = id;
    this.baseAddress = (opts.baseAddress ?? 0xe000) & 0xffff;
    const page = (opts.ioPage ?? 0xe) & 0x0f;
    this.portXE = (page << 4) | 0x0e;
    this.portXF = (page << 4) | 0x0f;
    this.stdGeometryName = opts.stdGeometry ?? 'std-sd';
    this.stdGeometry = GEOMETRIES[this.stdGeometryName];
    this.enabledAtReset = opts.enabledAtReset ?? true;
    this.enabled = this.enabledAtReset;
    this.stubRom = buildStubRom(this.baseAddress);

    if (opts.disks) {
      for (const [key, disk] of Object.entries(opts.disks)) this.disks.set(key, disk);
    }
    this.seedDefaults();

    const self = this;
    this.windowDevice = {
      id: `${id}:window`,
      basePorts: [],
      ioRead: (offset) => self.readWindow(offset),
      ioWrite: (offset, value) => self.writeWindow(offset, value),
      reset: () => self.reset(),
    };
    this.enableDevice = {
      id: `${id}:enable`,
      basePorts: [this.portXE, this.portXF],
      ioRead: () => 0xff, // write-triggered ports; reads float high
      ioWrite: (port) => {
        if (port === self.portXF) self.enabled = true;
        else if (port === self.portXE) self.enabled = false;
      },
      reset: () => {},
    };
  }

  attach(bus: Bus): void {
    this.bus = bus;
    bus.attachMemory(new MemoryMappedIOAdapter(this.baseAddress, WINDOW_SIZE, this.windowDevice));
    bus.attachIODevice(this.enableDevice);
  }

  reset(): void {
    this.enabled = this.enabledAtReset;
    this.ptrPhase = 'none';
    this.operationPending = false;
    this.status = MdcStatus.SUCCESS;
    this.seedDefaults();
  }

  /** Register (or replace) a disk backend for a drive after construction. */
  setDisk(kind: DriveKind, drive: number, disk: MdcDioDisk): void {
    this.disks.set(`${kind}:${drive}`, disk);
  }

  // --- memory-window routing (offsets are region-relative, 0x000-0xFFF) ---

  private readWindow(offset: number): number {
    if (!this.enabled) return 0xff;
    if (offset < STUB_ROM_SIZE) return this.stubRom[offset] ?? 0xff;
    if (offset >= RAM_OFFSET && offset < RAM_OFFSET + RAM_SIZE) {
      return this.ram[offset - RAM_OFFSET] ?? 0xff;
    }
    if (this.isTrap(offset)) return this.status & 0xff; // 0 while pending
    return 0xff;
  }

  private writeWindow(offset: number, value: number): void {
    if (!this.enabled) return;
    if (offset < STUB_ROM_SIZE) return; // ROM: writes ignored
    if (offset >= RAM_OFFSET && offset < RAM_OFFSET + RAM_SIZE) {
      this.ram[offset - RAM_OFFSET] = u8(value);
      return;
    }
    switch (offset) {
      case TRAP_CMD_STD: this.startByteCommand('std', u8(value)); return;
      case TRAP_CMD_MINI: this.startByteCommand('mini', u8(value)); return;
      case TRAP_INIT: this.doInit(); return;
      case TRAP_BOOT_STD: this.startBoot('std'); return;
      case TRAP_BOOT_MINI: this.startBoot('mini'); return;
      default: return;
    }
  }

  private isTrap(offset: number): boolean {
    return (
      offset === TRAP_CMD_STD ||
      offset === TRAP_CMD_MINI ||
      offset === TRAP_INIT ||
      offset === TRAP_BOOT_STD ||
      offset === TRAP_BOOT_MINI
    );
  }

  // --- firmware behavior ---

  private startByteCommand(kind: DriveKind, value: number): void {
    // Byte Command 1 set-pointer: the two address bytes arrive as the next two
    // trap writes (each a separate CALL from the guest).
    if (this.ptrPhase === 'low') {
      this.ptrLow = value;
      this.ptrPhase = 'high';
      this.status = MdcStatus.SUCCESS;
      return;
    }
    if (this.ptrPhase === 'high') {
      this.pointers[this.pendingPtr] = (this.ptrLow | (value << 8)) & 0xffff;
      this.ptrPhase = 'none';
      this.status = MdcStatus.SUCCESS;
      return;
    }

    const cmd = (value >> 4) & 0x0f;
    const low = value & 0x0f;
    switch (cmd) {
      case 0: // execute the command string pointed to by pointer `low`
        this.executeStringCommand(kind, low);
        return;
      case 1: // set pointer `low` from the next two writes
        this.pendingPtr = low;
        this.ptrPhase = 'low';
        this.status = MdcStatus.SUCCESS;
        return;
      case 2: // restore selected drives — seeks are absolute here, so a no-op
        this.status = MdcStatus.SUCCESS;
        return;
      case 3: // software write-protect selected drives
        this.setWriteProtect(kind, low, true);
        this.status = MdcStatus.SUCCESS;
        return;
      case 4: // software write-enable selected drives
        this.setWriteProtect(kind, low, false);
        this.status = MdcStatus.SUCCESS;
        return;
      default: // 5-15: no operation
        this.status = MdcStatus.SUCCESS;
        return;
    }
  }

  private executeStringCommand(kind: DriveKind, ptr: number): void {
    const bus = this.bus;
    if (!bus) { this.status = MdcStatus.ERR_INOPERABLE; return; }
    this.status = 0; // pending — the stub polls until this goes non-zero
    this.operationPending = true;
    const ctx: CommandContext = {
      bus,
      addr: this.pointers[ptr] ?? 0,
      geometry: kind === 'mini' ? GEOMETRIES.mini : this.stdGeometry,
      getDisk: (drive) => this.disks.get(`${kind}:${drive}`),
      isSoftwareWriteProtected: (drive) => this.swp[kind][drive] ?? false,
      isHardwareWriteProtected: () => false,
    };
    executeCommand(ctx)
      .then((st) => { this.status = (st & 0xff) || MdcStatus.SUCCESS; })
      .catch(() => { this.status = MdcStatus.ERR_INOPERABLE; })
      .finally(() => { this.operationPending = false; });
  }

  private startBoot(kind: DriveKind): void {
    const bus = this.bus;
    const disk = this.disks.get(`${kind}:0`);
    if (!bus || !disk) { this.status = MdcStatus.ERR_NOT_READY; return; }
    this.status = 0;
    this.operationPending = true;
    // Bootstrap: track 0, sector 1 of drive 0 → main RAM 0x0000-0x007F.
    disk.readSector(0, 1)
      .then((data) => {
        for (let i = 0; i < SECTOR_SIZE; i++) bus.write(i & 0xffff, u8(data[i] ?? 0));
        this.status = MdcStatus.SUCCESS;
      })
      .catch(() => { this.status = MdcStatus.ERR_INOPERABLE; })
      .finally(() => { this.operationPending = false; });
  }

  private doInit(): void {
    this.seedDefaults();
    this.status = MdcStatus.SUCCESS;
  }

  private setWriteProtect(kind: DriveKind, mask: number, protectOn: boolean): void {
    const flags = this.swp[kind];
    for (let i = 0; i < flags.length; i++) {
      if ((mask & (1 << i)) !== 0) flags[i] = protectOn;
    }
  }

  /** Seed the drive-type RAM bytes, pointer defaults, and write-protect state —
   * done by INIT (E00C) and on reset. */
  private seedDefaults(): void {
    const stdType = this.stdGeometryName === 'std-dd' ? 3 : 2;
    for (let d = 0; d < 4; d++) this.ram[d] = stdType; // E800-E803 standard drives
    for (let d = 0; d < 3; d++) this.ram[4 + d] = 6; // E804-E806 mini drives (125 kHz FM)
    for (let p = 0; p < 16; p++) this.pointers[p] = p === 0 ? 0x0080 : (p << 12);
    this.swp.std.fill(false);
    this.swp.mini.fill(false);
  }
}
