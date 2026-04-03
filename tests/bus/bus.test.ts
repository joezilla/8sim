import { describe, it, expect } from 'vitest';
import { Bus } from '../../src/bus/Bus.js';
import { Ram } from '../../src/memory/Ram.js';
import { Rom } from '../../src/memory/Rom.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import type { IIODevice } from '../../src/interfaces/IIODevice.js';

class MockDevice implements IIODevice {
  id = 'mock';
  basePorts = [0x10, 0x11];
  lastWritePort = -1;
  lastWriteValue = -1;
  readValue = 0x42;

  ioRead(port: number): number { return this.readValue; }
  ioWrite(port: number, value: number): void {
    this.lastWritePort = port;
    this.lastWriteValue = value;
  }
  reset(): void { this.lastWritePort = -1; this.lastWriteValue = -1; }
}

describe('Bus', () => {
  it('routes memory reads to correct region', () => {
    const pic = new InterruptController();
    const bus = new Bus(pic);
    const ram = new Ram('ram', 0x1000, 0x100);
    ram.write(0x10, 0xab);
    bus.attachMemory(ram);

    expect(bus.read(0x1010)).toBe(0xab);
  });

  it('returns 0xFF for unmapped reads', () => {
    const pic = new InterruptController();
    const bus = new Bus(pic);
    expect(bus.read(0x5000)).toBe(0xff);
  });

  it('ROM write is silently ignored', () => {
    const pic = new InterruptController();
    const bus = new Bus(pic);
    const rom = new Rom('rom', 0x0000, new Uint8Array([0x01, 0x02, 0x03]));
    bus.attachMemory(rom);

    bus.write(0x0000, 0xff); // should be ignored
    expect(bus.read(0x0000)).toBe(0x01); // original value unchanged
  });

  it('routes IO reads to device', () => {
    const pic = new InterruptController();
    const bus = new Bus(pic);
    const dev = new MockDevice();
    bus.attachIODevice(dev);

    expect(bus.ioRead(0x10)).toBe(0x42);
  });

  it('routes IO writes to device', () => {
    const pic = new InterruptController();
    const bus = new Bus(pic);
    const dev = new MockDevice();
    bus.attachIODevice(dev);

    bus.ioWrite(0x11, 0x55);
    expect(dev.lastWritePort).toBe(0x11);
    expect(dev.lastWriteValue).toBe(0x55);
  });

  it('unregistered IO port returns 0xFF', () => {
    const pic = new InterruptController();
    const bus = new Bus(pic);
    expect(bus.ioRead(0x20)).toBe(0xff);
  });

  it('multiple memory regions coexist', () => {
    const pic = new InterruptController();
    const bus = new Bus(pic);
    const ram1 = new Ram('ram1', 0x0000, 0x1000);
    const ram2 = new Ram('ram2', 0x1000, 0x1000);
    ram1.write(0, 0xaa);
    ram2.write(0, 0xbb);
    bus.attachMemory(ram1);
    bus.attachMemory(ram2);

    expect(bus.read(0x0000)).toBe(0xaa);
    expect(bus.read(0x1000)).toBe(0xbb);
  });

  it('acknowledgeInterrupt calls pic.acknowledge()', () => {
    const pic = new InterruptController();
    pic.assertIRQ(3);
    const bus = new Bus(pic);
    const rstByte = bus.acknowledgeInterrupt();
    // RST 3 = 0xC7 | (3 << 3) = 0xC7 | 0x18 = 0xDF
    expect(rstByte).toBe(0xdf);
  });
});
