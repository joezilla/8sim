import type { IMemory } from '../interfaces/IMemory.js';
import type { IIODevice } from '../interfaces/IIODevice.js';

export class MemoryMappedIOAdapter implements IMemory {
  readonly id: string;
  readonly baseAddress: number;
  readonly size: number;
  readonly readOnly = false;
  private device: IIODevice;

  constructor(baseAddress: number, size: number, device: IIODevice) {
    this.id = `mmio:${device.id}`;
    this.baseAddress = baseAddress & 0xffff;
    this.size = size;
    this.device = device;
  }

  read(offset: number): number {
    return this.device.ioRead(offset);
  }

  write(offset: number, value: number): void {
    this.device.ioWrite(offset, value);
  }

  reset(): void {
    this.device.reset();
  }
}
