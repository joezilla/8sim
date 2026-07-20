import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IMemory } from '../interfaces/IMemory.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { u8 } from '../util/bits.js';

export interface BootRomCardOptions {
  /** Base address of the overlay window. */
  readonly window?: number;
  /** Bytes the overlay spans. */
  readonly size?: number;
  /** I/O port whose write pages the overlay out (mirrors Cromemco port 0x40). */
  readonly controlPort?: number;
  /**
   * If set, only a write of this exact value to the control port disables the
   * overlay; otherwise ANY write disables it (the Cromemco 64FDC behavior).
   */
  readonly disableValue?: number;
  /**
   * `true` (default): writes into the window always fall through to the shadow
   * RAM underneath, so bytes written under the ROM survive the page-out (the
   * IMSAI MPU-B write-through shadow). `false`: writes are dropped while the
   * overlay is active (strict Cromemco 64FDC), and only take effect once paged
   * out.
   */
  readonly writeThrough?: boolean;
  /** ROM image; padded with 0xFF (unprogrammed EPROM) and truncated to `size`. */
  readonly image?: Uint8Array;
}

/**
 * Boot / phantom ROM overlay card — the S-100 autoboot trick modeled on
 * z80pack's Cromemco 64FDC boot ROM and IMSAI MPU-B shadow ROM. A monitor/boot
 * ROM shadows a fixed window at power-on so the CPU can run firmware straight out
 * of reset; a write to the control port pages the ROM out to reveal the RAM
 * hidden beneath it, so software takes over the same addresses.
 *
 * Like {@link BankRamCard}, the card OWNS its window and switches behavior inside
 * its own `read`/`write` — the engine's Bus is first-region-wins with no shadow
 * or write-through across regions, so the overlay logic (read ROM vs. RAM, drop
 * vs. pass-through writes) has to live in one card-owned memory module. Keep the
 * window clear of other RAM/ROM (the engine can't overlap-check card-attached
 * memory).
 */
export class BootRomCard implements IS100Card {
  readonly id: string;
  private readonly rom: Uint8Array;
  private readonly shadow: Uint8Array;
  private readonly controlPort: number;
  private readonly disableValue?: number;
  private readonly writeThrough: boolean;
  private enabled = true;
  private readonly mem: IMemory;
  private readonly dev: IIODevice;

  constructor(id = 'bootrom', opts: BootRomCardOptions = {}) {
    this.id = id;
    const window = (opts.window ?? 0xc000) & 0xffff;
    const size = Math.max(1, Math.min(0x10000, opts.size ?? 0x0800));
    this.controlPort = (opts.controlPort ?? 0x40) & 0xff;
    this.disableValue = opts.disableValue == null ? undefined : opts.disableValue & 0xff;
    this.writeThrough = opts.writeThrough ?? true;

    // Unprogrammed EPROM reads 0xFF; the image fills from the bottom of the window.
    this.rom = new Uint8Array(size).fill(0xff);
    if (opts.image) this.rom.set(opts.image.subarray(0, size));
    this.shadow = new Uint8Array(size);

    const self = this;
    this.mem = {
      id: `${id}:rom`,
      baseAddress: window,
      size,
      // Never truly read-only: the Bus must call our write so we can shadow it.
      readOnly: false,
      read: (offset: number) => (self.enabled ? self.rom[offset]! : self.shadow[offset]!),
      write: (offset: number, value: number) => {
        // Overlay active + drop-mode → the write is lost (Cromemco). Otherwise it
        // lands in the shadow RAM (write-through, or the ROM already paged out).
        if (self.enabled && !self.writeThrough) return;
        self.shadow[offset] = u8(value);
      },
      reset: () => { self.enabled = true; self.shadow.fill(0); },
    };
    this.dev = {
      id: `${id}:ctrl`,
      basePorts: [this.controlPort],
      // Status: bit 0 reflects whether the overlay is still mapped in.
      ioRead: () => (self.enabled ? 0x01 : 0x00),
      ioWrite: (_port: number, value: number) => {
        if (self.disableValue === undefined || (value & 0xff) === self.disableValue) {
          self.enabled = false;
        }
      },
      reset: () => { self.enabled = true; },
    };
  }

  attach(bus: Bus): void {
    bus.attachMemory(this.mem);
    bus.attachIODevice(this.dev);
  }

  reset(): void {
    this.enabled = true;
    this.shadow.fill(0);
  }
}
