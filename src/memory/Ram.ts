import type { IMemory } from '../interfaces/IMemory.js';
import { u8 } from '../util/bits.js';

export class Ram implements IMemory {
  readonly id: string;
  readonly baseAddress: number;
  readonly size: number;
  readonly readOnly = false;
  private data: Uint8Array;

  constructor(id: string, baseAddress: number, size: number) {
    this.id = id;
    this.baseAddress = baseAddress & 0xffff;
    this.size = size;
    this.data = new Uint8Array(size);
  }

  read(offset: number): number {
    if (offset < 0 || offset >= this.size) return 0xff;
    return this.data[offset] ?? 0xff;
  }

  write(offset: number, value: number): void {
    if (offset < 0 || offset >= this.size) return;
    this.data[offset] = u8(value);
  }

  reset(): void {
    this.data.fill(0);
  }

  /** Load bytes into RAM starting at offset */
  load(data: Uint8Array, offset = 0): void {
    this.data.set(data, offset);
  }

  /** Direct access for testing */
  getBytes(): Uint8Array {
    return this.data;
  }
}
