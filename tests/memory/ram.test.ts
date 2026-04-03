import { describe, it, expect } from 'vitest';
import { Ram } from '../../src/memory/Ram.js';
import { Rom } from '../../src/memory/Rom.js';
import { MemoryMappedIOAdapter } from '../../src/memory/MemoryMappedIOAdapter.js';
import type { IIODevice } from '../../src/interfaces/IIODevice.js';

class SimpleDevice implements IIODevice {
  id = 'simple';
  basePorts = [0];
  private regs = new Uint8Array(16);

  ioRead(port: number): number { return this.regs[port] ?? 0xff; }
  ioWrite(port: number, value: number): void { this.regs[port] = value; }
  reset(): void { this.regs.fill(0); }
}

describe('RAM', () => {
  it('reads and writes bytes', () => {
    const ram = new Ram('test', 0, 256);
    ram.write(10, 0xab);
    expect(ram.read(10)).toBe(0xab);
  });

  it('masks writes to uint8', () => {
    const ram = new Ram('test', 0, 256);
    ram.write(0, 0x1ff);
    expect(ram.read(0)).toBe(0xff);
  });

  it('reset clears all bytes', () => {
    const ram = new Ram('test', 0, 256);
    ram.write(5, 0xff);
    ram.reset();
    expect(ram.read(5)).toBe(0);
  });

  it('load fills from Uint8Array', () => {
    const ram = new Ram('test', 0, 256);
    ram.load(new Uint8Array([1, 2, 3]), 10);
    expect(ram.read(10)).toBe(1);
    expect(ram.read(11)).toBe(2);
    expect(ram.read(12)).toBe(3);
  });

  it('returns 0xFF for out-of-range reads', () => {
    const ram = new Ram('test', 0, 256);
    expect(ram.read(256)).toBe(0xff);
  });
});

describe('ROM', () => {
  it('reads from initial data', () => {
    const rom = new Rom('rom', 0x8000, new Uint8Array([0xaa, 0xbb, 0xcc]));
    expect(rom.read(0)).toBe(0xaa);
    expect(rom.read(2)).toBe(0xcc);
  });

  it('ignores writes', () => {
    const rom = new Rom('rom', 0, new Uint8Array([0x01]));
    rom.write(0, 0xff);
    expect(rom.read(0)).toBe(0x01);
  });
});

describe('MemoryMappedIOAdapter', () => {
  it('forwards reads to device', () => {
    const dev = new SimpleDevice();
    dev.ioWrite(0, 0x42);
    const adapter = new MemoryMappedIOAdapter(0x8000, 16, dev);
    expect(adapter.read(0)).toBe(0x42);
  });

  it('forwards writes to device', () => {
    const dev = new SimpleDevice();
    const adapter = new MemoryMappedIOAdapter(0x8000, 16, dev);
    adapter.write(3, 0x99);
    expect(dev.ioRead(3)).toBe(0x99);
  });
});
