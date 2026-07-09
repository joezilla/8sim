import type { IIODevice } from '../interfaces/IIODevice.js';
import { u8 } from '../util/bits.js';

type TransmitCallback = (byte: number) => void;

export class Usart8251 implements IIODevice {
  readonly id: string;
  readonly basePorts: ReadonlyArray<number>;

  private phase: 'mode' | 'command' = 'mode';
  private modeWord = 0;
  private txEnable = false;
  private rxEnable = false;
  // 3-bit error field: bit0=PE, bit1=OE, bit2=FE — packed into status bits 3-5
  private errorFlags = 0;
  private rxQueue: number[] = [];
  private transmitCb: TransmitCallback | undefined;
  private ctsActive = true;
  private dsrActive = true;

  constructor(id: string, private readonly dataPort: number, private readonly ctrlPort: number) {
    this.id = id;
    this.basePorts = [dataPort, ctrlPort];
  }

  ioWrite(port: number, value: number): void {
    if (port === this.ctrlPort) {
      if (this.phase === 'mode') {
        this.modeWord = value;
        this.phase = 'command';
        return;
      }
      if ((value & 0x40) !== 0) {
        this.phase = 'mode';
        this.txEnable = false;
        this.rxEnable = false;
        this.errorFlags = 0;
        this.rxQueue = [];
        return;
      }
      this.txEnable = (value & 0x01) !== 0;
      this.rxEnable = (value & 0x04) !== 0;
      if ((value & 0x10) !== 0) {
        this.errorFlags = 0;
      }
      return;
    }
    if (port === this.dataPort) {
      if (this.txEnable && this.ctsActive) {
        this.transmitCb?.(u8(value));
      }
    }
  }

  ioRead(port: number): number {
    if (port === this.ctrlPort) {
      return this.buildStatus();
    }
    const byte = this.rxQueue.shift();
    return byte !== undefined ? byte : 0xff;
  }

  reset(): void {
    this.phase = 'mode';
    this.modeWord = 0;
    this.txEnable = false;
    this.rxEnable = false;
    this.errorFlags = 0;
    this.rxQueue = [];
    // transmitCb, ctsActive, dsrActive survive reset — they are host wiring
  }

  enqueueRx(byte: number): void {
    this.rxQueue.push(u8(byte));
  }

  onTransmit(cb: TransmitCallback): void {
    this.transmitCb = cb;
  }

  setCts(active: boolean): void {
    this.ctsActive = active;
  }

  setDsr(active: boolean): void {
    this.dsrActive = active;
  }

  private buildStatus(): number {
    const txRDY = this.txEnable && this.ctsActive ? 0x01 : 0;
    const rxRDY = this.rxEnable && this.rxQueue.length > 0 ? 0x02 : 0;
    const txEMPTY = 0x04;
    const errors = (this.errorFlags & 0x07) << 3;
    const dsr = this.dsrActive ? 0x80 : 0;
    return txRDY | rxRDY | txEMPTY | errors | dsr;
  }
}
