import type { IS100Card } from '../interfaces/IS100Card.js';
import type { Bus } from '../bus/Bus.js';
import { Mc6850Acia } from './Mc6850Acia.js';

export interface Sio2CardOptions {
  readonly basePort?: number; // default 0x10 (standard MITS base)
}

/**
 * MITS Altair 88-2SIO dual serial card — two Motorola MC6850 ACIAs. Consumes
 * four consecutive I/O addresses; the standard MITS base is 0x10:
 *
 *   base+0 / base+1   Port 0  — control/status (0x10) + data (0x11)
 *   base+2 / base+3   Port 1  — control/status (0x12) + data (0x13)
 *
 * Port 0 is the conventional console. The 88-2SIO is the assumed serial board
 * for nearly all MITS software (Altair BASIC, Altair DOS, and most CP/M BIOS
 * implementations), so this is the card to attach when booting Altair CP/M.
 */
export class Mits2SioCard implements IS100Card {
  readonly id: string;
  readonly port0: Mc6850Acia;
  readonly port1: Mc6850Acia;

  constructor(id = '2sio', options: Sio2CardOptions = {}) {
    const base = options.basePort ?? 0x10;
    this.id = id;
    this.port0 = new Mc6850Acia(`${id}:port0`, base + 0, base + 1);
    this.port1 = new Mc6850Acia(`${id}:port1`, base + 2, base + 3);
  }

  attach(bus: Bus): void {
    bus.attachIODevice(this.port0);
    bus.attachIODevice(this.port1);
  }

  wireToConsole(): void {
    this.port0.onTransmit((byte) => process.stdout.write(String.fromCharCode(byte & 0x7f)));
  }

  reset(): void {
    this.port0.reset();
    this.port1.reset();
  }
}
