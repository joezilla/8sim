import type { IBus } from '../interfaces/IBus.js';
import type { IBusObserver } from '../interfaces/IBusObserver.js';

export class SnoopBus implements IBus {
  private observers: IBusObserver[] = [];

  constructor(private inner: IBus) {}

  attach(observer: IBusObserver): void {
    this.observers.push(observer);
  }

  detach(observer: IBusObserver): void {
    const i = this.observers.indexOf(observer);
    if (i !== -1) this.observers.splice(i, 1);
  }

  read(address: number): number {
    const value = this.inner.read(address);
    for (const obs of this.observers) obs.onMemRead?.(address & 0xffff, value);
    return value;
  }

  write(address: number, value: number): void {
    this.inner.write(address, value);
    for (const obs of this.observers) obs.onMemWrite?.(address & 0xffff, value & 0xff);
  }

  ioRead(port: number): number {
    const value = this.inner.ioRead(port);
    for (const obs of this.observers) obs.onIoRead?.(port & 0xff, value);
    return value;
  }

  ioWrite(port: number, value: number): void {
    this.inner.ioWrite(port, value);
    for (const obs of this.observers) obs.onIoWrite?.(port & 0xff, value & 0xff);
  }

  acknowledgeInterrupt(): number {
    return this.inner.acknowledgeInterrupt();
  }
}
