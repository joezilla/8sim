import type { IS100Card } from '../interfaces/IS100Card.js';
import type { Bus } from '../bus/Bus.js';
import type { DisplaySurface } from './DisplaySurface.js';

/** Processor Technology VDM-1: 16 lines × 64 characters = 1024 bytes. */
const COLS = 64;
const ROWS = 16;
const SIZE = COLS * ROWS;

export interface VdmCardOptions {
  /** Video RAM base (the VDM-1 mapped its 1K at 0xCC00). */
  readonly base?: number;
}

/**
 * Processor Technology VDM-1 memory-mapped character display (Story 5.9).
 *
 * A passive display: 1 KB of video RAM the CPU writes ASCII into; a character
 * generator turns each byte into a glyph (bit 7 = inverse). The card owns no
 * memory of its own — its video RAM is a declared `MachineSpec.memory` region
 * (so it's overlap-validated and shows on the memory-map ribbon), and the card
 * reads it back through the bus each frame for the host to render.
 */
export class VdmCard implements IS100Card {
  readonly id: string;
  readonly display: DisplaySurface;
  private readonly base: number;
  private bus?: Bus;

  constructor(id = 'vdm', opts: VdmCardOptions = {}) {
    this.id = id;
    this.base = (opts.base ?? 0xcc00) & 0xffff;
    this.display = {
      descriptor: { mode: 'charGrid', cols: COLS, rows: ROWS, font: 'vdm', attrBit: 7 },
      frame: () => ({ bytes: this.readVram(), state: {} }),
    };
  }

  attach(bus: Bus): void {
    this.bus = bus; // the video RAM is a separate MachineSpec.memory region
  }

  reset(): void {}

  private readVram(): Uint8Array {
    const out = new Uint8Array(SIZE);
    const bus = this.bus;
    if (bus) for (let i = 0; i < SIZE; i++) out[i] = bus.read((this.base + i) & 0xffff) & 0xff;
    return out;
  }
}
