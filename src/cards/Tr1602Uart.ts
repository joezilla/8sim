import type { IIODevice } from '../interfaces/IIODevice.js';
import { u8 } from '../util/bits.js';

type TransmitCallback = (byte: number) => void;
type ControlCallback = (value: number) => void;

/**
 * TR1602B / TMS-6011 / AY-5-1013 / HD-6402 standalone UART, as used on the
 * IMSAI MIO board. Unlike the Intel 8251 (see {@link Usart8251}), this chip has
 * no software-writable mode/command registers — the data format is fixed by
 * hardware jumpers. There is therefore no initialization sequence, and the
 * transmitter is ready immediately after power-on. The UART itself has no CTS
 * awareness: TxRDY (TBRE) is high whenever the transmit buffer is empty.
 *
 * Occupies two consecutive I/O ports:
 *   dataPort   — read: received byte (clears Data-Received); write: transmit
 *   statusPort — read: status flags; write: board control register (8212)
 *
 * Status byte (SIO-2-compatible wiring — the recommended MIO configuration):
 *   bit0 TxRDY   (TBRE)  — 1 = ready to accept a byte to transmit (always 1)
 *   bit1 RxRDY   (DR)    — 1 = a received byte is available
 *   bit2 TxEMPTY (TRE)   — 1 = transmit shift register idle (always 1)
 *   bit3 PE              — parity error on the last received byte
 *   bit4 OE              — overrun (byte arrived before the previous was read)
 *   bit5 FE              — framing error on the last received byte
 *   bit6/7               — board-specific, unused here
 */
export class Tr1602Uart implements IIODevice {
  readonly id: string;
  readonly basePorts: ReadonlyArray<number>;

  // bit0=PE, bit1=OE, bit2=FE — positioned into status bits 3-5 when read.
  private errorFlags = 0;
  private rxQueue: number[] = [];
  private controlReg = 0;
  private transmitCb: TransmitCallback | undefined;
  private controlCb: ControlCallback | undefined;

  constructor(id: string, private readonly dataPort: number, private readonly statusPort: number) {
    this.id = id;
    this.basePorts = [dataPort, statusPort];
  }

  ioRead(port: number): number {
    if (port === this.statusPort) {
      return this.buildStatus();
    }
    // Data port read: pull the received byte, clearing Data-Received (DR).
    const byte = this.rxQueue.shift();
    if (this.rxQueue.length === 0) {
      this.errorFlags &= ~0x02; // overrun clears once the buffer drains
    }
    return byte !== undefined ? byte : 0xff;
  }

  ioWrite(port: number, value: number): void {
    if (port === this.statusPort) {
      // Board control register (8212): DTR / RTS / cassette motor / etc.
      this.controlReg = u8(value);
      this.controlCb?.(this.controlReg);
      return;
    }
    // Data port write: transmit immediately. The UART is always ready — no
    // init sequence and no CTS gating.
    this.transmitCb?.(u8(value));
  }

  reset(): void {
    this.errorFlags = 0;
    this.rxQueue = [];
    this.controlReg = 0;
    // transmitCb / controlCb survive reset — they are host wiring.
  }

  /**
   * Feed a received byte to the UART. Sets Data-Received (RxRDY). A byte
   * arriving while the single-byte buffer is still full flags an overrun (OE),
   * mirroring the TR1602's lack of a receive FIFO.
   */
  enqueueRx(byte: number): void {
    if (this.rxQueue.length > 0) {
      this.errorFlags |= 0x02; // OE: previous byte was not read in time
    }
    this.rxQueue.push(u8(byte));
  }

  onTransmit(cb: TransmitCallback): void {
    this.transmitCb = cb;
  }

  /** Register a callback fired on writes to the board control register. */
  onControl(cb: ControlCallback): void {
    this.controlCb = cb;
  }

  /** Last value written to the board control register (statusPort write). */
  get control(): number {
    return this.controlReg;
  }

  /** Inject receive error flags (parity / overrun / framing) for the next read. */
  setErrors(pe: boolean, oe: boolean, fe: boolean): void {
    this.errorFlags = (pe ? 0x01 : 0) | (oe ? 0x02 : 0) | (fe ? 0x04 : 0);
  }

  private buildStatus(): number {
    const txRDY = 0x01;   // transmit buffer always ready
    const rxRDY = this.rxQueue.length > 0 ? 0x02 : 0;
    const txEMPTY = 0x04; // transmit register always idle
    const errors = (this.errorFlags & 0x07) << 3;
    return txRDY | rxRDY | txEMPTY | errors;
  }
}
