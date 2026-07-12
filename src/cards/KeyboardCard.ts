import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { u8 } from '../util/bits.js';

/**
 * The host-side surface a keyboard peripheral binds to (Story 5.9). The host
 * (fdcplus-web) drives key presses in from a real keyboard; the guest reads
 * them from the card's data port. This is the input counterpart to
 * {@link SerialCard.channel} / {@link ParallelCard.gpio} / {@link VdmCard.display}.
 */
export interface KeyboardPort {
  /** Queue a single key (ASCII/byte) for the guest to read from the data port. */
  press(byte: number): void;
  /** Queue each character of a string — convenience for a host paste. */
  type(text: string): void;
  /** How many keys are waiting to be read. */
  readonly pending: number;
}

export interface KeyboardCardOptions {
  readonly dataPort?: number;
  readonly statusPort?: number;
  /** Bits asserted on the status port while a key is waiting (default 0x01). */
  readonly readyMask?: number;
}

/**
 * Input-only keyboard port device — a FIFO of key bytes behind a data + status
 * port, the classic parallel-ASCII keyboard interface of a VDM-1 / Dazzler
 * video terminal (no serial line). The guest polls the status port for the
 * ready bit(s), then reads the data port to take the next key (which
 * acknowledges it). Writes are ignored — a keyboard is read-only on the bus.
 */
class KeyboardDevice implements IIODevice {
  readonly id: string;
  readonly basePorts: ReadonlyArray<number>;
  private readonly dataPort: number;
  private readonly statusPort: number;
  private readonly readyMask: number;
  private queue: number[] = [];

  constructor(id: string, dataPort: number, statusPort: number, readyMask: number) {
    this.id = id;
    this.dataPort = u8(dataPort);
    this.statusPort = u8(statusPort);
    this.readyMask = u8(readyMask);
    // A single-port keyboard (data === status) collapses to one claim; the data
    // read wins the dispatch below so the guest can still take keys.
    this.basePorts =
      this.dataPort === this.statusPort ? [this.dataPort] : [this.dataPort, this.statusPort];
  }

  ioRead(port: number): number {
    const p = u8(port);
    if (p === this.dataPort) return this.queue.shift() ?? 0; // take next key, acknowledge
    if (p === this.statusPort) return this.queue.length > 0 ? this.readyMask : 0;
    return 0;
  }

  ioWrite(): void {
    // input-only: a keyboard doesn't respond to CPU writes
  }

  reset(): void {
    this.queue.length = 0;
  }

  press(byte: number): void {
    this.queue.push(u8(byte));
  }

  get pending(): number {
    return this.queue.length;
  }
}

/**
 * A keyboard input card — the general ASCII-keyboard board that authored
 * keyboard cards resolve to (Story 5.9). It exposes a `keyboard` surface so the
 * host wires it to the operator's real keyboard, mirroring how SerialCard
 * exposes `channel` and VdmCard exposes `display`.
 */
export class KeyboardCard implements IS100Card {
  readonly id: string;
  readonly keyboard: KeyboardPort;
  private readonly dev: KeyboardDevice;

  constructor(id = 'keyboard', opts: KeyboardCardOptions = {}) {
    this.id = id;
    this.dev = new KeyboardDevice(
      `${id}:kbd`,
      opts.dataPort ?? 0x01,
      opts.statusPort ?? 0x00,
      opts.readyMask ?? 0x01,
    );
    const dev = this.dev;
    this.keyboard = {
      press: (byte: number) => dev.press(byte),
      type: (text: string) => {
        for (let i = 0; i < text.length; i++) dev.press(text.charCodeAt(i));
      },
      get pending() {
        return dev.pending;
      },
    };
  }

  attach(bus: Bus): void {
    bus.attachIODevice(this.dev);
  }

  reset(): void {
    this.dev.reset();
  }
}
