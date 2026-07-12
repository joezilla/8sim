import type { IS100Card } from '../interfaces/IS100Card.js';
import type { Bus } from '../bus/Bus.js';
import { Port8212 } from './Port8212.js';

/** Data direction of a parallel port from the operator's peripheral view. */
export type PortDirection = 'out' | 'in' | 'inout';

export interface ParallelCardOptions {
  readonly port?: number;
  readonly direction?: PortDirection;
}

/** The host-side surface a GPIO peripheral (LEDs / switches / printer) binds to. */
export interface GpioPort {
  readonly direction: PortDirection;
  /** The byte the CPU last latched on the output pins (drive LEDs / a printer). */
  read(): number;
  /** Drive the input pins — the value the CPU reads (sense switches). */
  setInput(byte: number): void;
  /** Fired whenever the CPU writes the output latch. */
  onOutput(cb: (byte: number) => void): void;
}

/**
 * A single 8-bit parallel I/O card (Story 5.8) — an 8212-style latched port the
 * general GPIO cards resolve to. A CPU write latches the output byte; a CPU read
 * returns the input pins. It exposes a `gpio` surface so the host wires it to a
 * peripheral — an LED bank, sense switches, a printer, or real hardware GPIO.
 * `direction` is a hint for the peripheral viewer (the 8212 is bidirectional).
 */
export class ParallelCard implements IS100Card {
  readonly id: string;
  readonly direction: PortDirection;
  readonly gpio: GpioPort;
  private readonly dev: Port8212;

  constructor(id = 'parallel', opts: ParallelCardOptions = {}) {
    this.id = id;
    this.direction = opts.direction ?? 'out';
    this.dev = new Port8212(`${id}:port`, opts.port ?? 0x00);
    this.gpio = {
      direction: this.direction,
      read: () => this.dev.output,
      setInput: (byte: number) => this.dev.setInput(byte),
      onOutput: (cb: (byte: number) => void) => this.dev.onWrite(cb),
    };
  }

  attach(bus: Bus): void {
    bus.attachIODevice(this.dev);
  }

  reset(): void {
    this.dev.reset();
  }
}
