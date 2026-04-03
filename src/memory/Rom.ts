import type { IMemory } from '../interfaces/IMemory.js';

export class Rom implements IMemory {
  readonly id: string;
  readonly baseAddress: number;
  readonly size: number;
  readonly readOnly = true;
  private data: Uint8Array;

  constructor(id: string, baseAddress: number, data: Uint8Array) {
    this.id = id;
    this.baseAddress = baseAddress & 0xffff;
    this.size = data.length;
    this.data = new Uint8Array(data);
  }

  read(offset: number): number {
    if (offset < 0 || offset >= this.size) return 0xff;
    return this.data[offset] ?? 0xff;
  }

  write(_offset: number, _value: number): void {
    // ROM is read-only; writes silently ignored
  }

  reset(): void {
    // ROM content is immutable
  }
}
