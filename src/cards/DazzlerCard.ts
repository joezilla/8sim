import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import type { DisplaySurface } from './DisplaySurface.js';

/** The Dazzler DMAs at most 2 KB (its high-resolution buffer) from system RAM. */
const MAX_BUFFER = 2048;

export interface DazzlerCardOptions {
  /** Control port — D7 enables the picture, D0–D6 select the buffer page. */
  readonly controlPort?: number;
  /** Format port — resolution / colour / memory-size bits. */
  readonly formatPort?: number;
}

/**
 * Cromemco Dazzler (Story 5.9) — the first S-100 colour graphics card (1976).
 *
 * Unlike the VDM-1 (which *is* the video RAM, memory-mapped), the Dazzler is a
 * DMA display: the CPU points it at any page of ordinary system RAM and it reads
 * the pixels back over the bus each frame. Two output ports drive it:
 *
 *  - control (0x0E): D7 = picture on, D0–D6 = buffer page (base = page << 9).
 *  - format  (0x0F): D6 = 2K/512, D5 = X4 resolution, D4 = colour/mono, D0–D3 =
 *    the on-colour in monochrome X4 mode.
 *
 * The card exposes a `bitmap` display surface carrying the raw quadrant-
 * interleaved buffer plus the format state; the host unpacks it (de-interleave +
 * 4-bit RGBI palette). Reading the control port returns a toggling frame-sync
 * bit (D6) so retrace-polling software makes progress.
 */
export class DazzlerCard implements IS100Card {
  readonly id: string;
  readonly display: DisplaySurface;
  private readonly controlPort: number;
  private readonly formatPort: number;
  private control = 0; // D7 = on, D0–D6 = page
  private format = 0; // resolution / colour / size
  private frameFlip = 0; // toggling sync bit for control-port reads
  private bus?: Bus;
  private readonly dev: IIODevice;

  constructor(id = 'dazzler', opts: DazzlerCardOptions = {}) {
    this.id = id;
    this.controlPort = (opts.controlPort ?? 0x0e) & 0xff;
    this.formatPort = (opts.formatPort ?? 0x0f) & 0xff;
    const self = this;
    this.dev = {
      id: `${id}:io`,
      basePorts:
        this.controlPort === this.formatPort ? [this.controlPort] : [this.controlPort, this.formatPort],
      ioRead(port: number): number {
        if ((port & 0xff) === self.controlPort) {
          self.frameFlip ^= 0x40; // vertical-retrace sync bit toggles each read
          return self.frameFlip;
        }
        return 0;
      },
      ioWrite(port: number, value: number): void {
        if ((port & 0xff) === self.controlPort) self.control = value & 0xff;
        else if ((port & 0xff) === self.formatPort) self.format = value & 0xff;
      },
      reset(): void {
        self.control = 0;
        self.format = 0;
        self.frameFlip = 0;
      },
    };
    this.display = {
      descriptor: { mode: 'bitmap', width: 128, height: 128, format: 'dazzler' },
      frame: () => ({
        bytes: this.dma(),
        state: { on: (this.control >> 7) & 1, format: this.format, control: this.control },
      }),
    };
  }

  attach(bus: Bus): void {
    this.bus = bus;
    bus.attachIODevice(this.dev);
  }

  reset(): void {
    this.dev.reset();
  }

  /** DMA the display buffer out of system RAM at the current page. */
  private dma(): Uint8Array {
    const out = new Uint8Array(MAX_BUFFER);
    const bus = this.bus;
    if (!bus) return out;
    const base = (this.control & 0x7f) << 9;
    for (let i = 0; i < MAX_BUFFER; i++) out[i] = bus.read((base + i) & 0xffff) & 0xff;
    return out;
  }
}
