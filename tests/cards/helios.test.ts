import { describe, it, expect } from 'vitest';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Bus } from '../../src/bus/Bus.js';
import { Ram } from '../../src/memory/Ram.js';
import { HeliosCard } from '../../src/cards/HeliosCard.js';
import { InMemoryHeliosDisk, HeliosRangeError, type HeliosDisk } from '../../src/cards/helios/HeliosDisk.js';

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function harness(disks?: Record<string, HeliosDisk>) {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0x0000, 0x10000);
  bus.attachMemory(ram);
  const card = new HeliosCard('helios', { port: 0xf0, disks });
  card.attach(bus);
  return { bus, card };
}

// F0 status bits
const TC = 0x01, SREADY = 0x02, CRCCHK = 0x10, DISKRDY = 0x20, SEEKCMP = 0x40, INDEX = 0x80;

describe('InMemoryHeliosDisk', () => {
  it('SVH round-trips and reads data across sectors', async () => {
    const disk = new InMemoryHeliosDisk();
    const payload = new Uint8Array(832).map((_, i) => (i * 7) & 0xff);
    await disk.writeData(0, 0, payload); // spans sector 0 (256) + 1 (320) + 2 (256)
    const back = await disk.readData(0, 0, 832);
    expect(Array.from(back)).toEqual(Array.from(payload));
    const re = InMemoryHeliosDisk.fromSvh(disk.toSvh());
    expect(Array.from(await re.readData(0, 0, 832))).toEqual(Array.from(payload));
  });

  it('reads/writes the 13-byte block header', async () => {
    const disk = new InMemoryHeliosDisk();
    const hdr = new Uint8Array([0, 5, 1, 5, 0xff, 0xff, 0x34, 0x12, 1, 0x00, 0x01, 0, 0]);
    await disk.writeHeader(5, 0, hdr);
    expect(Array.from(await disk.readHeader(5, 0))).toEqual(Array.from(hdr));
  });

  it('rejects out-of-range track/sector', async () => {
    const disk = new InMemoryHeliosDisk();
    await expect(disk.readData(77, 0, 1)).rejects.toBeInstanceOf(HeliosRangeError);
    await expect(disk.readHeader(0, 16)).rejects.toBeInstanceOf(HeliosRangeError);
  });
});

describe('HeliosCard ports + drive command', () => {
  it('claims 8 consecutive ports F0-F7', () => {
    const { bus } = harness();
    // status readable at F0; other ports are write-only (read 0xFF)
    expect(bus.ioRead(0xf0)).not.toBe(0xff); // status byte
    expect(bus.ioRead(0xf1)).toBe(0xff);
  });

  it('restore + head-load set seek-complete, index-present, ready', () => {
    const disk = new InMemoryHeliosDisk();
    const { bus } = harness({ '0': disk });
    bus.ioWrite(0xf7, 0xcf); // restore unit 0 (seek track 0)
    let s = bus.ioRead(0xf0);
    expect(s & SEEKCMP).toBe(0); // seek complete (bit6 = 0)
    expect(s & DISKRDY).toBe(0); // disk ready (bit5 = 0, disk mounted)
    bus.ioWrite(0xf7, 0xdf); // load head 0
    s = bus.ioRead(0xf0);
    expect(s & INDEX).toBe(0); // index present (bit7 = 0 once head loaded)
    expect(s & SREADY).toBe(SREADY); // ready
  });

  it('no disk on the selected unit reads not-ready (DISK-READY bit set)', () => {
    const { bus } = harness();
    bus.ioWrite(0xf7, 0xcf); // select unit 0, none mounted
    expect(bus.ioRead(0xf0) & DISKRDY).toBe(DISKRDY);
  });
});

describe('HeliosCard DMA transfers', () => {
  async function setup(disk: InMemoryHeliosDisk) {
    const { bus } = harness({ '0': disk });
    bus.ioWrite(0xf7, 0xcf); // restore unit 0
    bus.ioWrite(0xf7, 0xdf); // load head
    return bus;
  }

  it('READ DATA DMAs a block from disk to host RAM and latches TC/CRC-checked', async () => {
    const disk = new InMemoryHeliosDisk();
    const pattern = new Uint8Array(256).map((_, i) => (i ^ 0x5a) & 0xff);
    await disk.writeData(3, 0, pattern);
    const bus = harness({ '0': disk }).bus;
    // seek to track 3 (restore then step 3×)
    bus.ioWrite(0xf7, 0xcf); // restore -> track 0
    for (let i = 0; i < 3; i++) bus.ioWrite(0xf7, 0xfc); // step inward to higher track (bit0=0 step, bit1=0 higher)
    bus.ioWrite(0xf7, 0xdf); // load head
    bus.ioWrite(0xf5, 0x00); bus.ioWrite(0xf6, 0x04); // DMA addr 0x0400
    bus.ioWrite(0xf3, 0x00); bus.ioWrite(0xf4, 0x01); // length 0x100 = 256
    bus.ioWrite(0xf1, 0x03); // READ DATA
    await flush();
    const s = bus.ioRead(0xf0);
    expect(s & TC).toBe(TC);
    expect(s & CRCCHK).toBe(CRCCHK);
    for (let i = 0; i < 256; i++) expect(bus.read(0x0400 + i)).toBe(pattern[i]);
  });

  it('WRITE DATA DMAs from host RAM to disk', async () => {
    const disk = new InMemoryHeliosDisk();
    const bus = await setup(disk);
    for (let i = 0; i < 256; i++) bus.write(0x0500 + i, (0xa0 + i) & 0xff);
    bus.ioWrite(0xf5, 0x00); bus.ioWrite(0xf6, 0x05); // addr 0x0500
    bus.ioWrite(0xf3, 0x00); bus.ioWrite(0xf4, 0x01); // 256 bytes
    bus.ioWrite(0xf1, 0x01); // WRITE DATA (bit1=0 write, bit2=0 data, bit3=0 execute)
    await flush();
    const back = await disk.readData(0, 0, 256);
    for (let i = 0; i < 256; i++) expect(back[i]).toBe((0xa0 + i) & 0xff);
  });

  it('F5 write clears the latched status bits', async () => {
    const disk = new InMemoryHeliosDisk();
    await disk.writeData(0, 0, new Uint8Array(64).fill(1));
    const bus = await setup(disk);
    bus.ioWrite(0xf3, 0x40); bus.ioWrite(0xf4, 0x00); // len 64
    bus.ioWrite(0xf1, 0x03); await flush(); // READ DATA -> sets TC
    expect(bus.ioRead(0xf0) & TC).toBe(TC);
    bus.ioWrite(0xf5, 0x00); // clears status
    expect(bus.ioRead(0xf0) & (TC | CRCCHK)).toBe(0);
  });
});
