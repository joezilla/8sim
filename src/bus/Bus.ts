import type { IBus } from '../interfaces/IBus.js';
import type { IMemory } from '../interfaces/IMemory.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { IInterruptController } from '../interfaces/IInterruptController.js';
import { createRegion, type BusRegion } from './BusRegion.js';
import { IoSpace } from '../io/IoSpace.js';

export class Bus implements IBus {
  private regions: BusRegion[] = [];
  private ioSpace: IoSpace;
  private pic: IInterruptController;

  constructor(pic: IInterruptController) {
    this.pic = pic;
    this.ioSpace = new IoSpace();
  }

  attachMemory(mem: IMemory): void {
    this.regions.push(createRegion(mem));
    this.regions.sort((a, b) => a.start - b.start);
  }

  attachIODevice(dev: IIODevice): void {
    this.ioSpace.register(dev);
  }

  read(address: number): number {
    const addr = address & 0xffff;
    const region = this.findRegion(addr);
    if (region === undefined) return 0xff;
    return region.module.read(addr - region.start);
  }

  write(address: number, value: number): void {
    const addr = address & 0xffff;
    const region = this.findRegion(addr);
    if (region === undefined) return;
    if (region.module.readOnly) return;
    region.module.write(addr - region.start, value);
  }

  ioRead(port: number): number {
    return this.ioSpace.read(port & 0xff);
  }

  ioWrite(port: number, value: number): void {
    this.ioSpace.write(port & 0xff, value & 0xff);
  }

  acknowledgeInterrupt(): number {
    return this.pic.acknowledge();
  }

  getPic(): IInterruptController {
    return this.pic;
  }

  reset(): void {
    for (const region of this.regions) {
      region.module.reset();
    }
    this.ioSpace.reset();
    this.pic.reset();
  }

  private findRegion(addr: number): BusRegion | undefined {
    for (const region of this.regions) {
      if (addr >= region.start && addr <= region.end) {
        return region;
      }
    }
    return undefined;
  }
}
