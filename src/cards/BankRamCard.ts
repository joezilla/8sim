import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IMemory } from '../interfaces/IMemory.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { u8 } from '../util/bits.js';

export interface BankRamCardOptions {
  /** Address of the switched window (top of the CPU's 64K it appears in). */
  readonly window?: number;
  /** Bytes visible in the window (one bank's worth). */
  readonly size?: number;
  /** How many banks of RAM the card carries. */
  readonly banks?: number;
  /** I/O port that selects the active bank. */
  readonly selectPort?: number;
}

/**
 * Bank-switching RAM card (Story 5.10) — the S-100 way past the 8080/Z80's 64K
 * ceiling. The card carries N banks of RAM but shows only one at a time in a
 * fixed address window; a write to the select port swaps which bank is visible.
 * Total RAM is banks × size, addressable a window at a time (the classic
 * Cromemco/North Star / CP/M-80 bank scheme).
 *
 * The card manages its own memory, so it attaches a banked region directly to
 * the bus rather than declaring a static MachineSpec region — keep the window
 * clear of other RAM/ROM (the engine can't overlap-check card-attached memory).
 */
export class BankRamCard implements IS100Card {
  readonly id: string;
  private readonly banks: Uint8Array[];
  private readonly selectPort: number;
  private current = 0;
  private readonly mem: IMemory;
  private readonly dev: IIODevice;

  constructor(id = 'bankram', opts: BankRamCardOptions = {}) {
    this.id = id;
    const window = (opts.window ?? 0xc000) & 0xffff;
    const size = Math.max(1, Math.min(0x10000, opts.size ?? 0x4000));
    const bankCount = Math.max(1, Math.min(256, opts.banks ?? 4));
    this.selectPort = (opts.selectPort ?? 0x40) & 0xff;
    this.banks = Array.from({ length: bankCount }, () => new Uint8Array(size));

    const self = this;
    this.mem = {
      id: `${id}:ram`,
      baseAddress: window,
      size,
      readOnly: false,
      read: (offset: number) => self.banks[self.current]![offset] ?? 0xff,
      write: (offset: number, value: number) => { self.banks[self.current]![offset] = u8(value); },
      reset: () => { for (const b of self.banks) b.fill(0); self.current = 0; },
    };
    this.dev = {
      id: `${id}:sel`,
      basePorts: [this.selectPort],
      ioRead: () => self.current & 0xff,
      ioWrite: (_port: number, value: number) => { self.current = (value & 0xff) % self.banks.length; },
      reset: () => { self.current = 0; },
    };
  }

  attach(bus: Bus): void {
    bus.attachMemory(this.mem);
    bus.attachIODevice(this.dev);
  }

  reset(): void {
    for (const b of this.banks) b.fill(0);
    this.current = 0;
  }
}
