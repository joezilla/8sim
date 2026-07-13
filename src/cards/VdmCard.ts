import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import type { DisplaySurface } from './DisplaySurface.js';

/** Processor Technology VDM-1: 16 lines × 64 characters = 1024 bytes. */
const COLS = 64;
const ROWS = 16;
const SIZE = COLS * ROWS;

export interface VdmCardOptions {
  /** Video RAM base (the VDM-1 mapped its 1K at 0xCC00). */
  readonly base?: number;
  /**
   * Display-parameter (DSTAT) I/O port (default 0xFE). The VDM-1 exposes a
   * write-only control port whose low nibble sets the scroll origin — the screen
   * line shown at the top. SOLOS writes it to reset scroll on erase and to
   * hardware-scroll. Pass `null` to model a card without the control port.
   */
  readonly dstatPort?: number | null;
}

/**
 * The VDM-1's write-only display-parameter port (DSTAT). A write loads the
 * scroll register; its low nibble is the screen line shown at the top, so the
 * host renders the 16-line grid starting there (wrapping). Reads float high.
 */
class VdmDstatPort implements IIODevice {
  readonly id: string;
  readonly basePorts: ReadonlyArray<number>;
  scroll = 0;

  constructor(id: string, port: number) {
    this.id = id;
    this.basePorts = [port & 0xff];
  }

  ioRead(): number {
    return 0xff; // write-only control port
  }

  ioWrite(_port: number, value: number): void {
    this.scroll = value & 0x0f; // low nibble = top screen line
  }

  reset(): void {
    this.scroll = 0;
  }
}

/**
 * Processor Technology VDM-1 memory-mapped character display (Story 5.9).
 *
 * A passive display: 1 KB of video RAM the CPU writes ASCII into; a character
 * generator turns each byte into a glyph (bit 7 = inverse). The card owns no
 * memory of its own — its video RAM is a declared `MachineSpec.memory` region
 * (so it's overlap-validated and shows on the memory-map ribbon), and the card
 * reads it back through the bus each frame for the host to render. It also
 * claims the DSTAT control port (default 0xFE) so hardware scrolling is modeled:
 * the scroll origin rides in the frame's `state.scroll`.
 */
export class VdmCard implements IS100Card {
  readonly id: string;
  readonly display: DisplaySurface;
  private readonly base: number;
  private readonly dstat?: VdmDstatPort;
  private bus?: Bus;

  constructor(id = 'vdm', opts: VdmCardOptions = {}) {
    this.id = id;
    this.base = (opts.base ?? 0xcc00) & 0xffff;
    const dstatPort = opts.dstatPort === undefined ? 0xfe : opts.dstatPort;
    this.dstat = dstatPort === null ? undefined : new VdmDstatPort(`${id}:dstat`, dstatPort);
    this.display = {
      descriptor: { mode: 'charGrid', cols: COLS, rows: ROWS, font: 'vdm', attrBit: 7 },
      frame: () => ({ bytes: this.readVram(), state: { scroll: this.dstat?.scroll ?? 0 } }),
    };
  }

  attach(bus: Bus): void {
    this.bus = bus; // the video RAM is a separate MachineSpec.memory region
    if (this.dstat) bus.attachIODevice(this.dstat);
  }

  reset(): void {
    this.dstat?.reset();
  }

  private readVram(): Uint8Array {
    const out = new Uint8Array(SIZE);
    const bus = this.bus;
    if (bus) for (let i = 0; i < SIZE; i++) out[i] = bus.read((this.base + i) & 0xffff) & 0xff;
    return out;
  }
}
