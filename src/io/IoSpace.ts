import type { IIODevice } from '../interfaces/IIODevice.js';

export class IoSpace {
  private devices = new Map<number, IIODevice>();

  register(dev: IIODevice): void {
    for (const port of dev.basePorts) {
      this.devices.set(port & 0xff, dev);
    }
  }

  read(port: number): number {
    const dev = this.devices.get(port & 0xff);
    if (dev === undefined) return 0xff;
    return dev.ioRead(port & 0xff);
  }

  write(port: number, value: number): void {
    const dev = this.devices.get(port & 0xff);
    if (dev === undefined) return;
    dev.ioWrite(port & 0xff, value & 0xff);
  }

  reset(): void {
    const seen = new Set<IIODevice>();
    for (const dev of this.devices.values()) {
      if (!seen.has(dev)) {
        seen.add(dev);
        dev.reset();
      }
    }
  }
}
