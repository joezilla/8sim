import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { Usart8251 } from './Usart8251.js';
import { writeHostStdout } from '../util/hostConsole.js';

export interface SioCardOptions {
  readonly basePortA?: number;
  readonly basePortB?: number;
  readonly boardCtrlPort?: number;
}

class SioBoardCtrl implements IIODevice {
  readonly id: string;
  readonly basePorts: ReadonlyArray<number>;

  constructor(id: string, port: number, private readonly a: Usart8251, private readonly b: Usart8251) {
    this.id = id;
    this.basePorts = [port];
  }

  ioRead(_port: number): number {
    return 0xff;
  }

  ioWrite(_port: number, value: number): void {
    if ((value & 0x03) !== 0) this.a.reset();
    if ((value & 0x0c) !== 0) this.b.reset();
  }

  reset(): void {}
}

export class ImsaiSioCard implements IS100Card {
  readonly id: string;
  readonly channelA: Usart8251;
  readonly channelB: Usart8251;
  private readonly boardCtrl: SioBoardCtrl;

  constructor(id = 'sio2', options: SioCardOptions = {}) {
    const portA = options.basePortA ?? 0x02;
    const portB = options.basePortB ?? 0x04;
    const ctrlPort = options.boardCtrlPort ?? 0x08;
    this.id = id;
    this.channelA = new Usart8251(`${id}:a`, portA, portA + 1);
    this.channelB = new Usart8251(`${id}:b`, portB, portB + 1);
    this.boardCtrl = new SioBoardCtrl(`${id}:ctrl`, ctrlPort, this.channelA, this.channelB);
  }

  attach(bus: Bus): void {
    bus.attachIODevice(this.channelA);
    bus.attachIODevice(this.channelB);
    bus.attachIODevice(this.boardCtrl);
  }

  wireToConsole(): void {
    const write = (byte: number) => writeHostStdout(String.fromCharCode(byte));
    this.channelA.onTransmit(write);
    this.channelB.onTransmit(write);
  }

  reset(): void {
    this.channelA.reset();
    this.channelB.reset();
  }
}
