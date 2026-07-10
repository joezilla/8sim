import type { IS100Card } from '../interfaces/IS100Card.js';
import type { Bus } from '../bus/Bus.js';
import { Tr1602Uart } from './Tr1602Uart.js';
import { Port8212 } from './Port8212.js';

export interface MioCardOptions {
  readonly basePort?: number; // default 0x10 → serial at 0x12/0x13
}

/**
 * IMSAI MIO (Multiple Input/Output) S-100 card (1977). A multifunction I/O
 * board combining a TR1602 UART serial port, two 8212 parallel ports, and a
 * board control register, on four consecutive I/O addresses:
 *
 *   base+0  Port A  — 8212 parallel I/O
 *   base+1  Port B  — 8212 parallel I/O
 *   base+2  serial data     (read: RX / write: TX)
 *   base+3  serial status   (read) / board control (write)
 *
 * The base address is jumper-selectable on real hardware. The default of 0x10
 * places the serial port at 0x12/0x13 (the standard MIO layout). Use
 * `basePort: 0x00` to relocate the serial port to 0x02/0x03 for SIO-2-
 * compatible console duty.
 *
 * Unlike {@link ImsaiSioCard} (Intel 8251), the MIO's TR1602 UART needs no
 * initialization and is always transmit-ready.
 */
export class ImsaiMioCard implements IS100Card {
  readonly id: string;
  readonly portA: Port8212;
  readonly portB: Port8212;
  readonly uart: Tr1602Uart;

  constructor(id = 'mio', options: MioCardOptions = {}) {
    const base = options.basePort ?? 0x10;
    this.id = id;
    this.portA = new Port8212(`${id}:portA`, base + 0);
    this.portB = new Port8212(`${id}:portB`, base + 1);
    this.uart = new Tr1602Uart(`${id}:uart`, base + 2, base + 3);
  }

  attach(bus: Bus): void {
    bus.attachIODevice(this.portA);
    bus.attachIODevice(this.portB);
    bus.attachIODevice(this.uart);
  }

  wireToConsole(): void {
    this.uart.onTransmit((byte) => process.stdout.write(String.fromCharCode(byte & 0x7f)));
  }

  reset(): void {
    this.portA.reset();
    this.portB.reset();
    this.uart.reset();
  }
}
