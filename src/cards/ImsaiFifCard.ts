import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { u8 } from '../util/bits.js';
import { type FloppyDisk, SECTOR_SIZE } from './floppy/FloppyDisk.js';
import { executeDescriptor, FifStatus, type FifContext } from './fif/fifDescriptor.js';

/** Where the monitor loads and runs the boot sector (memon80 BOTADR). */
export const FIF_BOOT_ADDR = 0x0080;

export interface ImsaiFifOptions {
  /** Command port; IMSAI standard is 0xFD. */
  readonly port?: number;
  /** Disk backends keyed by drive number as a string, e.g. `{ '0': disk }`. */
  readonly disks?: Record<string, FloppyDisk>;
}

/**
 * IMSAI FIF (IFM + FIB) Floppy Disk System controller — Story 5.12.
 *
 * Unlike the memory-mapped, firmware-`CALL` MDC-DIO, the FIF presents itself to
 * host software as a **single output port (0xFD)** plus **DMA** into main RAM.
 * The host builds a 7-byte *descriptor* in its own memory, `OUT`s a one-byte
 * command to 0xFD, and polls a result byte inside the descriptor that the
 * controller writes (by DMA) on completion. There is no memory window and no
 * firmware ROM to model — it is a plain `IIODevice` that holds an `IBus`
 * reference for DMA (the `DazzlerCard` idiom).
 *
 * Behavior is matched to z80pack's `imsai-fif.c`, so the same IMSAI disk images
 * (imdos202.dsk, cpm22.dsk, …) boot. See {@link executeDescriptor}.
 */
export class ImsaiFifCard implements IS100Card {
  readonly id: string;
  private readonly port: number;
  private readonly pointers = new Uint16Array(16);
  private readonly swp = [false, false, false, false]; // per-drive software write-protect
  private readonly disks = new Map<number, FloppyDisk>();

  // OUT 0xFD state machine: 0 = idle, 1 = expecting pointer LSB, 2 = expecting MSB.
  private fdState: 0 | 1 | 2 = 0;
  private pendingPtr = 0;
  private ptrLow = 0;

  private bus?: Bus;
  private readonly dev: IIODevice;

  constructor(id = 'fif', opts: ImsaiFifOptions = {}) {
    this.id = id;
    this.port = (opts.port ?? 0xfd) & 0xff;
    this.seedPointers();
    if (opts.disks) {
      for (const [key, disk] of Object.entries(opts.disks)) {
        const drive = Number(key);
        if (Number.isInteger(drive) && drive >= 0 && drive < 4) this.disks.set(drive, disk);
      }
    }

    const self = this;
    this.dev = {
      id: `${id}:fdc`,
      basePorts: [this.port],
      ioRead: () => 0xff, // output-only port; results come back via DMA
      ioWrite: (_port, value) => self.handleOut(u8(value)),
      reset: () => self.reset(),
    };
  }

  attach(bus: Bus): void {
    this.bus = bus;
    bus.attachIODevice(this.dev);
  }

  reset(): void {
    this.fdState = 0;
    this.seedPointers();
    this.swp.fill(false);
  }

  /** Register (or replace) a disk backend for a drive after construction. */
  setDisk(drive: number, disk: FloppyDisk): void {
    if (drive >= 0 && drive < 4) this.disks.set(drive, disk);
  }

  /**
   * Bootstrap: read drive/track0/sector1 into main RAM at 0x0080 (memon80
   * BOTDSK/BOTSEC/BOTADR). The caller then sets PC = 0x0080 and runs; the loaded
   * sector drives the FIF via OUT 0xFD to load the rest of the OS. Resolves true
   * on success.
   */
  async boot(drive = 0): Promise<boolean> {
    const bus = this.bus;
    const disk = this.disks.get(drive);
    if (!bus || !disk) return false;
    const data = await disk.readSector(0, 1);
    for (let i = 0; i < SECTOR_SIZE; i++) bus.write((FIF_BOOT_ADDR + i) & 0xffff, u8(data[i] ?? 0));
    return true;
  }

  // --- OUT 0xFD state machine (matches z80pack imsai_fif_out) ---

  private handleOut(value: number): void {
    switch (this.fdState) {
      case 0: {
        const cmd = (value >> 4) & 0x0f;
        const low = value & 0x0f;
        switch (cmd) {
          case 0x0: // execute descriptor at pointer `low`
            this.execute(low);
            return;
          case 0x1: // set pointer `low`: next two OUTs are LSB, MSB
            this.pendingPtr = low;
            this.fdState = 1;
            return;
          case 0x2: // restore drive(s) — seeks are absolute here, so a no-op
            return;
          case 0x3: // software write-protect selected drive(s)
            this.setWriteProtect(low, true);
            return;
          case 0x4: // software write-enable selected drive(s)
            this.setWriteProtect(low, false);
            return;
          default: // 5-15: no-op (5 = reset-interrupt / reset-boot, unmodeled)
            return;
        }
      }
      case 1: // LSB of the descriptor address
        this.ptrLow = value;
        this.fdState = 2;
        return;
      case 2: // MSB of the descriptor address
        this.pointers[this.pendingPtr] = (this.ptrLow | (value << 8)) & 0xffff;
        this.fdState = 0;
        return;
    }
  }

  private execute(ptr: number): void {
    const bus = this.bus;
    if (!bus) return;
    const addr = this.pointers[ptr] ?? 0;
    const ctx: FifContext = {
      bus,
      addr,
      getDisk: (drive) => this.disks.get(drive),
      isSoftwareWriteProtected: (drive) => this.swp[drive] ?? false,
      isHardwareWriteProtected: () => false,
    };
    // Fire-and-forget: executeDescriptor DMAs the result byte back into the
    // descriptor when the (possibly async) disk op completes; the guest polls
    // it. On an unexpected failure, still write an error so the poll terminates.
    executeDescriptor(ctx).catch(() => {
      bus.write((addr + 1) & 0xffff, FifStatus.ERR_DATA);
    });
  }

  private setWriteProtect(mask: number, protectOn: boolean): void {
    for (let i = 0; i < 4; i++) {
      if ((mask & (1 << i)) !== 0) this.swp[i] = protectOn;
    }
  }

  /** Reset the 16 pointers to the power-on defaults (N→N×0x1000, 0→0x0080). */
  private seedPointers(): void {
    for (let p = 0; p < 16; p++) this.pointers[p] = p === 0 ? 0x0080 : (p << 12);
  }
}
