import { describe, it, expect } from 'vitest';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Bus } from '../../src/bus/Bus.js';
import { Ram } from '../../src/memory/Ram.js';
import { ImsaiMdcDioCard } from '../../src/cards/ImsaiMdcDioCard.js';
import { InMemoryMdcDioDisk, type MdcDioDisk } from '../../src/cards/mdcdio/MdcDioDisk.js';
import { MdcStatus } from '../../src/cards/mdcdio/commandString.js';

// Absolute trap addresses within the E000 window.
const CMD_STD = 0xec00;
const INIT = 0xec02;

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

function harness(disks?: Record<string, MdcDioDisk>) {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0x0000, 0xe000); // 0..DFFF, clear of the E000 window
  bus.attachMemory(ram);
  const card = new ImsaiMdcDioCard('mdc', disks ? { disks } : {});
  card.attach(bus);

  /** Build a command string, point pointer 0 at it, execute, return the status. */
  async function exec(cmd: number[], addr = 0x0200): Promise<number> {
    bus.write(CMD_STD, 0x10); // Byte Command 1: set pointer 0
    bus.write(CMD_STD, addr & 0xff);
    bus.write(CMD_STD, (addr >> 8) & 0xff);
    cmd.forEach((b, i) => bus.write(addr + i, b & 0xff));
    bus.write(CMD_STD, 0x00); // Byte Command 0: execute via pointer 0
    await flush();
    return bus.read(CMD_STD);
  }

  return { bus, ram, card, exec };
}

/** Command byte: cmd 2 READ, drive 0. */
function readCmd(track: number, sector: number, buf: number): number[] {
  return [0x21, 0x00, 0x00, track, sector, buf & 0xff, (buf >> 8) & 0xff];
}

describe('ImsaiMdcDioCard window routing', () => {
  it('serves stub ROM, on-board RAM, and 0xFF for undefined MMIO', () => {
    const { bus } = harness();
    expect(bus.read(0xe000)).toBe(0xc3); // stub ROM vector
    bus.write(0xe000, 0x00); // ROM writes ignored
    expect(bus.read(0xe000)).toBe(0xc3);
    bus.write(0xe880, 0x5a); // user RAM (E880-E8FF)
    expect(bus.read(0xe880)).toBe(0x5a);
    expect(bus.read(0xe900)).toBe(0xff); // undefined MMIO reads high
  });

  it('XE disables and XF re-enables the window', () => {
    const { bus } = harness();
    bus.ioWrite(0xee, 0); // XE (page E) → disable
    expect(bus.read(0xe000)).toBe(0xff);
    bus.ioWrite(0xef, 0); // XF → enable
    expect(bus.read(0xe000)).toBe(0xc3);
  });
});

describe('ImsaiMdcDioCard INIT', () => {
  it('seeds drive-type bytes at E800-E806', () => {
    const { bus } = harness();
    bus.write(INIT, 0);
    for (let d = 0; d < 4; d++) expect(bus.read(0xe800 + d)).toBe(2); // std-sd
    for (let d = 0; d < 3; d++) expect(bus.read(0xe804 + d)).toBe(6); // mini
  });
});

describe('ImsaiMdcDioCard command strings', () => {
  it('reads a sector into main RAM (pointer set + execute)', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    const pattern = new Uint8Array(128).map((_, i) => (i + 1) & 0xff);
    await disk.writeSector(1, 2, pattern);
    const { bus, exec } = harness({ 'std:0': disk });

    const status = await exec(readCmd(1, 2, 0x0300));
    expect(status).toBe(MdcStatus.SUCCESS);
    expect(bus.read(0x0201)).toBe(MdcStatus.SUCCESS); // status also in Byte2
    for (let i = 0; i < 128; i++) expect(bus.read(0x0300 + i)).toBe(pattern[i]);
  });

  it('writes a sector from main RAM and reads it back', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    const { bus, exec } = harness({ 'std:0': disk });
    for (let i = 0; i < 128; i++) bus.write(0x0400 + i, (0xa0 + i) & 0xff);

    const wr = await exec([0x11, 0, 0, 3, 4, 0x00, 0x04]); // WRITE track3 sec4 buf 0x0400
    expect(wr).toBe(MdcStatus.SUCCESS);
    const back = await disk.readSector(3, 4);
    for (let i = 0; i < 128; i++) expect(back[i]).toBe((0xa0 + i) & 0xff);
  });

  it('formats a track (fills E5)', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd', new Uint8Array(256256).fill(0x11));
    const { exec } = harness({ 'std:0': disk });
    const st = await exec([0x31, 0, 0, 6]); // FORMAT track6, drive0
    expect(st).toBe(MdcStatus.SUCCESS);
    const s = await disk.readSector(6, 1);
    expect(s.every((b) => b === 0xe5)).toBe(true);
  });

  it('maps command-string errors to C2..C7', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    const { exec } = harness({ 'std:0': disk });
    expect(await exec([0x20, 0, 0, 0, 1, 0, 3])).toBe(MdcStatus.ERR_NO_DRIVE); // mask 0
    expect(await exec([0x23, 0, 0, 0, 1, 0, 3])).toBe(MdcStatus.ERR_MULTI_DRIVE); // mask 3
    expect(await exec([0x61, 0, 0, 0, 1, 0, 3])).toBe(MdcStatus.ERR_BAD_CMD); // cmd 6
    expect(await exec([0x21, 0, 0, 77, 1, 0, 3])).toBe(MdcStatus.ERR_TRACK); // track 77
    expect(await exec([0x21, 0, 0, 0, 27, 0, 3])).toBe(MdcStatus.ERR_SECTOR); // sector 27
    expect(await exec([0x21, 0, 0, 0, 1, 0, 0xe0])).toBe(MdcStatus.ERR_BUFFER); // buf hi E0
  });

  it('honors software write-protect (3X sets, 4X clears)', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    const { bus, exec } = harness({ 'std:0': disk });
    for (let i = 0; i < 128; i++) bus.write(0x0400 + i, i & 0xff);

    bus.write(CMD_STD, 0x31); // Byte Command 3: SW write-protect drive 0
    expect(await exec([0x11, 0, 0, 1, 1, 0x00, 0x04])).toBe(MdcStatus.ERR_SW_WP);
    bus.write(CMD_STD, 0x41); // Byte Command 4: write-enable drive 0
    expect(await exec([0x11, 0, 0, 1, 1, 0x00, 0x04])).toBe(MdcStatus.SUCCESS);
  });

  it('write-deleted mark makes a subsequent read return 0x97 (data still delivered)', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    const pattern = new Uint8Array(128).fill(0x7e);
    await disk.writeSector(1, 1, pattern);
    const { bus, exec } = harness({ 'std:0': disk });

    expect(await exec([0x51, 0, 0, 1, 1])).toBe(MdcStatus.SUCCESS); // WRITE DELETED (1,1)
    const st = await exec(readCmd(1, 1, 0x0300));
    expect(st).toBe(MdcStatus.DELETED);
    expect(bus.read(0x0300)).toBe(0x7e); // data transferred despite the mark
  });

  it('reports not-ready when no disk is mounted', async () => {
    const { exec } = harness(); // no disks
    expect(await exec(readCmd(0, 1, 0x0300))).toBe(MdcStatus.ERR_NOT_READY);
  });

  it('pointer 0 defaults to 0x0080 after INIT (execute without re-pointing)', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    const pattern = new Uint8Array(128).fill(0x33);
    await disk.writeSector(0, 1, pattern);
    const { bus } = harness({ 'std:0': disk });
    bus.write(INIT, 0); // seeds pointer 0 = 0x0080
    // Build a READ command string directly at 0x0080 and execute pointer 0.
    readCmd(0, 1, 0x0300).forEach((b, i) => bus.write(0x0080 + i, b));
    bus.write(CMD_STD, 0x00);
    await flush();
    expect(bus.read(CMD_STD)).toBe(MdcStatus.SUCCESS);
    expect(bus.read(0x0300)).toBe(0x33);
  });
});
