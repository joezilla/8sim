import { describe, it, expect } from 'vitest';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Bus } from '../../src/bus/Bus.js';
import { Ram } from '../../src/memory/Ram.js';
import { ImsaiFifCard } from '../../src/cards/ImsaiFifCard.js';
import { InMemoryFloppyDisk, type FloppyDisk } from '../../src/cards/floppy/FloppyDisk.js';
import { FifStatus } from '../../src/cards/fif/fifDescriptor.js';

const FDC = 0xfd;
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function harness(disks?: Record<string, FloppyDisk>) {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0x0000, 0x10000);
  bus.attachMemory(ram);
  const card = new ImsaiFifCard('fif', disks ? { disks } : {});
  card.attach(bus);

  /** Set pointer 0 → descriptor, load it, execute, return the result byte (B1). */
  async function exec(cmd: number[], addr = 0x1880): Promise<number> {
    bus.ioWrite(FDC, 0x10); // Byte Command 1: set pointer 0
    bus.ioWrite(FDC, addr & 0xff);
    bus.ioWrite(FDC, (addr >> 8) & 0xff);
    cmd.forEach((b, i) => bus.write(addr + i, b & 0xff));
    bus.ioWrite(FDC, 0x00); // Byte Command 0: execute pointer 0
    await flush();
    return bus.read(addr + 1);
  }

  return { bus, ram, card, exec };
}

const readCmd = (track: number, sector: number, buf: number, unit = 1): number[] =>
  [(2 << 4) | unit, 0, 0, track, sector, buf & 0xff, (buf >> 8) & 0xff];

describe('ImsaiFifCard port 0xFD', () => {
  it('is output-only: IN 0xFD returns 0xFF', () => {
    const { bus } = harness();
    expect(bus.ioRead(0xfd)).toBe(0xff);
  });

  it('reads a sector via the full OUT 0xFD sequence', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    const pattern = new Uint8Array(128).map((_, i) => (i ^ 0x33) & 0xff);
    await disk.writeSector(1, 2, pattern);
    const { bus, exec } = harness({ '0': disk });

    expect(await exec(readCmd(1, 2, 0x0300))).toBe(FifStatus.SUCCESS);
    for (let i = 0; i < 128; i++) expect(bus.read(0x0300 + i)).toBe(pattern[i]);
  });

  it('writes then reads back a sector', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    const { bus, exec } = harness({ '0': disk });
    for (let i = 0; i < 128; i++) bus.write(0x0500 + i, (0xc0 + i) & 0xff);
    expect(await exec([(1 << 4) | 1, 0, 0, 5, 6, 0x00, 0x05])).toBe(FifStatus.SUCCESS);
    const back = await disk.readSector(5, 6);
    for (let i = 0; i < 128; i++) expect(back[i]).toBe((0xc0 + i) & 0xff);
  });

  it('honors pointer 0 default (0x0080) after reset', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    await disk.writeSector(0, 1, new Uint8Array(128).fill(0x44));
    const { bus } = harness({ '0': disk });
    // Build a READ descriptor directly at 0x0080 and execute pointer 0 (no set-pointer).
    readCmd(0, 1, 0x0300).forEach((b, i) => bus.write(0x0080 + i, b));
    bus.ioWrite(FDC, 0x00);
    await flush();
    expect(bus.read(0x0081)).toBe(FifStatus.SUCCESS);
    expect(bus.read(0x0300)).toBe(0x44);
  });

  it('set-pointer (0x1N, LSB, MSB) targets an arbitrary pointer', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    await disk.writeSector(2, 3, new Uint8Array(128).fill(0x5e));
    const { bus } = harness({ '0': disk });
    const addr = 0x2500;
    bus.ioWrite(FDC, 0x15); // set pointer 5
    bus.ioWrite(FDC, addr & 0xff);
    bus.ioWrite(FDC, (addr >> 8) & 0xff);
    readCmd(2, 3, 0x0300).forEach((b, i) => bus.write(addr + i, b));
    bus.ioWrite(FDC, 0x05); // execute pointer 5
    await flush();
    expect(bus.read(addr + 1)).toBe(FifStatus.SUCCESS);
    expect(bus.read(0x0300)).toBe(0x5e);
  });

  it('drive-select 1/2/4/8 pick drives 0-3; C2/C3 for bad masks', async () => {
    const d0 = new InMemoryFloppyDisk('std-sd');
    const d3 = new InMemoryFloppyDisk('std-sd');
    await d3.writeSector(0, 1, new Uint8Array(128).fill(0x9a));
    const { bus, exec } = harness({ '0': d0, '3': d3 });
    expect(await exec(readCmd(0, 1, 0x0300, 8))).toBe(FifStatus.SUCCESS); // unit 8 → drive 3
    expect(bus.read(0x0300)).toBe(0x9a);
    expect(await exec(readCmd(0, 1, 0x0300, 0))).toBe(FifStatus.ERR_NO_DRIVE);
    expect(await exec(readCmd(0, 1, 0x0300, 3))).toBe(FifStatus.ERR_MULTI_DRIVE);
  });

  it('software write-protect via 0x3N / 0x41', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    const { bus, exec } = harness({ '0': disk });
    for (let i = 0; i < 128; i++) bus.write(0x0500 + i, i & 0xff);
    bus.ioWrite(FDC, 0x31); // write-protect drive 0
    expect(await exec([(1 << 4) | 1, 0, 0, 0, 1, 0x00, 0x05])).toBe(FifStatus.ERR_SW_WP);
    bus.ioWrite(FDC, 0x41); // write-enable drive 0
    expect(await exec([(1 << 4) | 1, 0, 0, 0, 1, 0x00, 0x05])).toBe(FifStatus.SUCCESS);
  });

  it('boot() loads drive0/track0/sector1 to 0x0080', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    const boot = new Uint8Array(128).map((_, i) => (i + 1) & 0xff);
    await disk.writeSector(0, 1, boot);
    const { bus, card } = harness({ '0': disk });
    expect(await card.boot(0)).toBe(true);
    for (let i = 0; i < 128; i++) expect(bus.read(0x0080 + i)).toBe(boot[i]);
  });
});
