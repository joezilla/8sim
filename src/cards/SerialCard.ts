import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { Usart8251 } from './Usart8251.js';
import { Mc6850Acia } from './Mc6850Acia.js';

/** The UART chip a serial card is built around. */
export type SerialChip = 'i8251' | 'm6850';

/** A serial channel: an I/O device that also streams characters. */
interface SerialChannel extends IIODevice {
  onTransmit(cb: (byte: number) => void): void;
  enqueueRx(byte: number): void;
  reset(): void;
}

export interface SerialCardOptions {
  readonly dataPort?: number;
  readonly ctrlPort?: number;
  readonly chip?: SerialChip;
}

/**
 * A single-channel serial (UART) card — the general console board authored
 * serial cards resolve to (Story 5.7). Unlike a bare chip wrapped in
 * `deviceCard`, it exposes its `channel` so the host wires it to the operator
 * terminal (ConsoleHub looks for `.channel`). Backed by an 8251 or a 6850.
 */
export class SerialCard implements IS100Card {
  readonly id: string;
  readonly channel: SerialChannel;

  constructor(id = 'serial', opts: SerialCardOptions = {}) {
    const dataPort = opts.dataPort ?? 0x10;
    const ctrlPort = opts.ctrlPort ?? 0x11;
    this.id = id;
    this.channel =
      opts.chip === 'm6850'
        ? new Mc6850Acia(`${id}:ch`, ctrlPort, dataPort) // 6850: status/ctrl port, data port
        : new Usart8251(`${id}:ch`, dataPort, ctrlPort); // 8251: data port, ctrl port
  }

  attach(bus: Bus): void {
    bus.attachIODevice(this.channel);
  }

  reset(): void {
    this.channel.reset();
  }
}
