import { describe, it, expect } from 'vitest';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Bus } from '../../src/bus/Bus.js';
import { Ram } from '../../src/memory/Ram.js';
import { InMemoryFloppyDisk, type FloppyDisk } from '../../src/cards/floppy/FloppyDisk.js';
import {
  executeDescriptor,
  unitToDrive,
  FifStatus,
  type FifContext,
} from '../../src/cards/fif/fifDescriptor.js';

const ADDR = 0x1880; // descriptor location (matches the manual's sample)

interface Opts {
  disks?: Record<number, FloppyDisk>;
  swp?: Record<number, boolean>;
  hwp?: Record<number, boolean>;
}

function harness(opts: Opts = {}) {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0x0000, 0x10000);
  bus.attachMemory(ram);
  const ctx: FifContext = {
    bus,
    addr: ADDR,
    getDisk: (drive) => opts.disks?.[drive],
    isSoftwareWriteProtected: (drive) => opts.swp?.[drive] ?? false,
    isHardwareWriteProtected: (drive) => opts.hwp?.[drive] ?? false,
  };
  const putDescriptor = (bytes: number[]): void => bytes.forEach((b, i) => bus.write(ADDR + i, b));
  return { bus, ram, ctx, putDescriptor };
}

// B0 cmd<<4|unit, B1 result, B2 format, B3 track, B4 sector, B5/B6 buffer.
const read = (track: number, sector: number, buf: number, unit = 1): number[] =>
  [(2 << 4) | unit, 0, 0, track, sector, buf & 0xff, (buf >> 8) & 0xff];

describe('unitToDrive (drive-select 1/2/4/8)', () => {
  it('maps single-bit unit values to drives; others are invalid', () => {
    expect(unitToDrive(1)).toBe(0);
    expect(unitToDrive(2)).toBe(1);
    expect(unitToDrive(4)).toBe(2);
    expect(unitToDrive(8)).toBe(3);
    expect(unitToDrive(0)).toBe(-1);
    expect(unitToDrive(3)).toBe(-1);
    expect(unitToDrive(15)).toBe(-1);
  });
});

describe('FIF executeDescriptor', () => {
  it('READ transfers a sector to the DMA buffer and writes result 0x01', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    const pattern = new Uint8Array(128).map((_, i) => (i + 3) & 0xff);
    await disk.writeSector(1, 2, pattern);
    const h = harness({ disks: { 0: disk } });
    h.putDescriptor(read(1, 2, 0x0300));

    const st = await executeDescriptor(h.ctx);
    expect(st).toBe(FifStatus.SUCCESS);
    expect(h.bus.read(ADDR + 1)).toBe(FifStatus.SUCCESS); // result byte (B1)
    for (let i = 0; i < 128; i++) expect(h.bus.read(0x0300 + i)).toBe(pattern[i]);
  });

  it('WRITE stores the DMA buffer to the disk', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    const h = harness({ disks: { 0: disk } });
    for (let i = 0; i < 128; i++) h.bus.write(0x0400 + i, (0x10 + i) & 0xff);
    h.putDescriptor([(1 << 4) | 1, 0, 0, 3, 4, 0x00, 0x04]); // WRITE track3 sec4 buf 0x0400

    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.SUCCESS);
    const back = await disk.readSector(3, 4);
    for (let i = 0; i < 128; i++) expect(back[i]).toBe((0x10 + i) & 0xff);
  });

  it('FORMAT fills the track with E5 (no sector needed)', async () => {
    const disk = new InMemoryFloppyDisk('std-sd', new Uint8Array(256256).fill(0x11));
    const h = harness({ disks: { 0: disk } });
    h.putDescriptor([(3 << 4) | 1, 0, 0, 7]); // FORMAT track7
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.SUCCESS);
    const s = await disk.readSector(7, 1);
    expect(s.every((b) => b === 0xe5)).toBe(true);
  });

  it('drive-select value selects the right drive', async () => {
    const disk1 = new InMemoryFloppyDisk('std-sd');
    await disk1.writeSector(0, 1, new Uint8Array(128).fill(0x7a));
    const h = harness({ disks: { 1: disk1 } }); // drive 1 only
    h.putDescriptor(read(0, 1, 0x0300, 2)); // unit=2 → drive 1
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.SUCCESS);
    expect(h.bus.read(0x0300)).toBe(0x7a);
  });

  it('maps every error class', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    // C1: result byte not pre-cleared to 0
    let h = harness({ disks: { 0: disk } });
    h.putDescriptor([(2 << 4) | 1, 0x99, 0, 0, 1, 0, 3]);
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_RESULT_NOT_ZERO);
    // C2: no drive
    h = harness({ disks: { 0: disk } });
    h.putDescriptor([(2 << 4) | 0, 0, 0, 0, 1, 0, 3]);
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_NO_DRIVE);
    // C3: invalid multi-bit unit
    h = harness({ disks: { 0: disk } });
    h.putDescriptor([(2 << 4) | 3, 0, 0, 0, 1, 0, 3]);
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_MULTI_DRIVE);
    // C4: illegal command
    h = harness({ disks: { 0: disk } });
    h.putDescriptor([(5 << 4) | 1, 0, 0, 0, 1, 0, 3]);
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_BAD_CMD);
    // C8: format byte non-zero
    h = harness({ disks: { 0: disk } });
    h.putDescriptor([(2 << 4) | 1, 0, 0x01, 0, 1, 0, 3]);
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_FORMAT);
    // C5: track out of range
    h = harness({ disks: { 0: disk } });
    h.putDescriptor(read(77, 1, 0x0300));
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_TRACK);
    // C6: sector out of range
    h = harness({ disks: { 0: disk } });
    h.putDescriptor(read(0, 27, 0x0300));
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_SECTOR);
    // A1: no disk mounted
    h = harness({});
    h.putDescriptor(read(0, 1, 0x0300));
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_NOT_READY);
    // A2: hardware write-protect on a write
    h = harness({ disks: { 0: disk }, hwp: { 0: true } });
    h.putDescriptor([(1 << 4) | 1, 0, 0, 0, 1, 0, 3]);
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_HW_WP);
    // A3: software write-protect on a write
    h = harness({ disks: { 0: disk }, swp: { 0: true } });
    h.putDescriptor([(1 << 4) | 1, 0, 0, 0, 1, 0, 3]);
    expect(await executeDescriptor(h.ctx)).toBe(FifStatus.ERR_SW_WP);
  });
});
