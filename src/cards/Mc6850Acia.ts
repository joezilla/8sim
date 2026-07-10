import type { IIODevice } from '../interfaces/IIODevice.js';
import { u8 } from '../util/bits.js';

type TransmitCallback = (byte: number) => void;

/**
 * Motorola MC6850 ACIA, as used (×2) on the MITS Altair 88-2SIO board.
 *
 * Occupies two consecutive I/O ports — note the order is the OPPOSITE of the
 * Intel 8251 / TR1602 (which put data at the lower address):
 *   statusPort (base+0) — read: status register; write: control register
 *   dataPort   (base+1) — read: received byte;   write: transmit byte
 *
 * Status register:
 *   bit0 RDRF  — receive data register full (1 = byte available)
 *   bit1 TDRE  — transmit data register empty (1 = ready to accept a byte)
 *   bit2 DCD   — data carrier detect (1 = carrier lost)
 *   bit3 CTS   — clear-to-send input (1 = NOT clear to send)
 *   bit4 FE    — framing error
 *   bit5 OVRN  — receiver overrun
 *   bit6 PE    — parity error
 *   bit7 IRQ   — interrupt request pending
 *
 * Control register (write):
 *   bits1-0  counter divide / master reset (11 = master reset)
 *   bits4-2  word select (data bits / parity / stop bits — cosmetic here)
 *   bits6-5  transmit control (RTS state + TX interrupt enable)
 *   bit7     receive interrupt enable
 *
 * DCD and CTS default to their grounded (active) state — carrier present and
 * clear-to-send — matching a board jumpered for direct terminal use. With DCD
 * lost, RDRF is clamped to 0; with CTS not clear, TDRE is inhibited (the two
 * classic "my 2SIO doesn't work" failure modes).
 */
export class Mc6850Acia implements IIODevice {
  readonly id: string;
  readonly basePorts: ReadonlyArray<number>;

  private controlReg = 0;
  private rxQueue: number[] = [];
  // bit0=FE, bit1=OVRN, bit2=PE — positioned into status bits 4-6 when read.
  private errorFlags = 0;
  private rxIntEnable = false;
  private txIntEnable = false;
  private ctsClear = true;       // CTS input grounded → clear to send
  private carrierPresent = true; // DCD input grounded → carrier present
  private transmitCb: TransmitCallback | undefined;

  constructor(id: string, private readonly statusPort: number, private readonly dataPort: number) {
    this.id = id;
    this.basePorts = [statusPort, dataPort];
  }

  ioRead(port: number): number {
    if (port === this.statusPort) {
      return this.buildStatus();
    }
    // Data port read: pull the received byte, clearing RDRF (and overrun once
    // the buffer drains).
    const byte = this.rxQueue.shift();
    if (this.rxQueue.length === 0) {
      this.errorFlags &= ~0x02;
    }
    return byte !== undefined ? byte : 0xff;
  }

  ioWrite(port: number, value: number): void {
    if (port === this.statusPort) {
      this.writeControl(u8(value));
      return;
    }
    // Data port write: transmit, unless CTS says the peer is not ready.
    if (this.ctsClear) {
      this.transmitCb?.(u8(value));
    }
  }

  reset(): void {
    this.masterReset();
    this.controlReg = 0;
    // cts/dcd inputs and transmitCb survive reset — they are host wiring.
  }

  /**
   * Feed a received byte to the ACIA. Sets RDRF; a byte arriving while the
   * previous one has not been read flags an overrun (OVRN).
   */
  enqueueRx(byte: number): void {
    if (this.rxQueue.length > 0) {
      this.errorFlags |= 0x02; // OVRN
    }
    this.rxQueue.push(u8(byte));
  }

  onTransmit(cb: TransmitCallback): void {
    this.transmitCb = cb;
  }

  /** Drive the CTS input: true = clear to send (grounded), false = inhibited. */
  setCts(clear: boolean): void {
    this.ctsClear = clear;
  }

  /** Drive the DCD input: true = carrier present (grounded), false = lost. */
  setDcd(carrierPresent: boolean): void {
    this.carrierPresent = carrierPresent;
  }

  /** Inject receive error flags (framing / overrun / parity) for the next read. */
  setErrors(fe: boolean, ovrn: boolean, pe: boolean): void {
    this.errorFlags = (fe ? 0x01 : 0) | (ovrn ? 0x02 : 0) | (pe ? 0x04 : 0);
  }

  /** Last value written to the control register. */
  get control(): number {
    return this.controlReg;
  }

  private writeControl(value: number): void {
    this.controlReg = value;
    if ((value & 0x03) === 0x03) {
      this.masterReset();
      return;
    }
    this.rxIntEnable = (value & 0x80) !== 0;
    this.txIntEnable = (value & 0x60) === 0x20; // bits 6-5 == 01
  }

  private masterReset(): void {
    this.rxQueue = [];
    this.errorFlags = 0;
    this.rxIntEnable = false;
    this.txIntEnable = false;
  }

  private buildStatus(): number {
    const rdrf = this.rxQueue.length > 0 && this.carrierPresent ? 0x01 : 0;
    const tdre = this.ctsClear ? 0x02 : 0;
    const dcd = this.carrierPresent ? 0 : 0x04;
    const cts = this.ctsClear ? 0 : 0x08;
    const errs = (this.errorFlags & 0x07) << 4; // FE=bit4, OVRN=bit5, PE=bit6
    const irq =
      (this.rxIntEnable && rdrf !== 0) || (this.txIntEnable && tdre !== 0) ? 0x80 : 0;
    return rdrf | tdre | dcd | cts | errs | irq;
  }
}
