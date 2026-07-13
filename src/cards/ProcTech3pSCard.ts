import type { IS100Card } from '../interfaces/IS100Card.js';
import type { Bus } from '../bus/Bus.js';
import { writeHostStdout } from '../util/hostConsole.js';
import { ProcTech3pS, type ProcTech3pSOptions } from './ProcTech3pS.js';

export {
  ProcTech3pS,
  PT_NATIVE_STATUS,
  SIO2_STATUS,
} from './ProcTech3pS.js';
export type {
  ProcTech3pSOptions,
  ProcTech3pSInterruptOptions,
  ChannelOrder,
  ConfigMode,
  StatusFlag,
  StatusMap,
  WordFormat,
} from './ProcTech3pS.js';

/** Host-side surface for one UART serial channel. */
export interface SerialSurface {
  /** Fired with each byte the CPU transmits (Channel D OUT). */
  onTransmit(cb: (byte: number) => void): void;
  /** Deliver a received byte to the UART (sets RDA). */
  enqueueRx(byte: number): void;
}

/** Host-side surface for one parallel channel (A or B). */
export interface ParallelSurface {
  /** The byte the CPU last latched on the output pins. */
  read(): number;
  /** Drive the input pins without raising the data-available flag (sense switches). */
  setInput(byte: number): void;
  /** Present a byte from the device (XDAA/XDAB pulse) — raises FA/FB; the next
   * CPU read clears it. */
  pulseInput(byte: number): void;
  /** Set the external-device-ready line (XA/XB) for output handshaking. */
  setDeviceReady(ready: boolean): void;
  /** Fired whenever the CPU writes the output latch (output strobe). */
  onOutput(cb: (byte: number) => void): void;
}

/** A parallel-keyboard convenience surface (queues ASCII into a channel). */
export interface KeyboardSurface {
  press(byte: number): void;
  type(text: string): void;
}

/**
 * Processor Technology 3P+S I/O card (1976) — the thin S-100 wrapper around the
 * {@link ProcTech3pS} device, exposing host-wiring surfaces the way
 * {@link ImsaiMioCard} exposes `uart`/`portA`/`portB`.
 *
 *   - `serial` — the UART (Channel D): TX callback + RX injection.
 *   - `portA` / `portB` — the parallel ports (Channels A/B) with handshake.
 *   - `wireToConsole()` — route serial TX to the host stdout.
 *   - `wireKeyboard('A'|'B')` — attach an ASCII keyboard to a parallel channel.
 */
export class ProcTech3pSCard implements IS100Card {
  readonly id: string;
  private readonly dev: ProcTech3pS;
  readonly serial: SerialSurface;
  readonly portA: ParallelSurface;
  readonly portB: ParallelSurface;

  constructor(id = '3ps', options: ProcTech3pSOptions = {}) {
    this.id = id;
    this.dev = new ProcTech3pS(`${id}:dev`, options);
    this.serial = {
      onTransmit: (cb) => this.dev.onTransmit(cb),
      enqueueRx: (byte) => this.dev.enqueueRx(byte),
    };
    this.portA = this.makeParallel(0);
    this.portB = this.makeParallel(1);
  }

  private makeParallel(i: 0 | 1): ParallelSurface {
    return {
      read: () => this.dev.output(i),
      setInput: (byte) => this.dev.setInput(i, byte),
      pulseInput: (byte) => this.dev.pulseInput(i, byte),
      setDeviceReady: (ready) => this.dev.setDeviceReady(i, ready),
      onOutput: (cb) => this.dev.onOutput(i, cb),
    };
  }

  attach(bus: Bus): void {
    bus.attachIODevice(this.dev);
  }

  reset(): void {
    this.dev.reset();
  }

  /** Route serial transmit to the host console (7-bit ASCII), like ImsaiMioCard. */
  wireToConsole(): void {
    this.dev.onTransmit((byte) => writeHostStdout(String.fromCharCode(byte & 0x7f)));
  }

  /** Attach a parallel ASCII keyboard to Channel A or B (the CT1024 idiom). */
  wireKeyboard(channel: 'A' | 'B'): KeyboardSurface {
    const port = channel === 'B' ? this.portB : this.portA;
    return {
      press: (byte) => port.pulseInput(byte & 0xff),
      type: (text) => { for (const ch of text) port.pulseInput(ch.charCodeAt(0) & 0xff); },
    };
  }
}
