import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  GEOMETRIES,
  InMemoryMdcDioDisk,
  MdcDioRangeError,
  imageSize,
  trackLength,
  FORMAT_FILL,
} from '../../src/cards/mdcdio/MdcDioDisk.js';

describe('MdcDioDisk geometry', () => {
  it('std-sd is the 256,256-byte IBM 3740 image (77×26×128)', () => {
    expect(imageSize(GEOMETRIES['std-sd'])).toBe(256256);
    expect(trackLength(GEOMETRIES['std-sd'])).toBe(3328); // fdcplus track length
  });
  it('std-dd and mini sizes', () => {
    expect(imageSize(GEOMETRIES['std-dd'])).toBe(77 * 58 * 128);
    expect(imageSize(GEOMETRIES.mini)).toBe(35 * 18 * 128);
  });
});

describe('InMemoryMdcDioDisk', () => {
  it('round-trips a sector by physical (track, 1-based sector)', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    const data = new Uint8Array(128).map((_, i) => (i * 3) & 0xff);
    await disk.writeSector(1, 2, data);
    const back = await disk.readSector(1, 2);
    expect(Array.from(back)).toEqual(Array.from(data));
  });

  it('indexes offset = (track*sectors + (sector-1))*128', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    await disk.writeSector(2, 3, new Uint8Array(128).fill(0xaa));
    const raw = disk.toBytes();
    const off = (2 * 26 + (3 - 1)) * 128;
    expect(raw[off]).toBe(0xaa);
    expect(raw[off + 127]).toBe(0xaa);
  });

  it('rejects out-of-range track and sector', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    await expect(disk.readSector(77, 1)).rejects.toBeInstanceOf(MdcDioRangeError);
    await expect(disk.readSector(0, 27)).rejects.toBeInstanceOf(MdcDioRangeError);
    await expect(disk.readSector(0, 0)).rejects.toBeInstanceOf(MdcDioRangeError);
  });

  it('formatTrack fills the track with E5', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd', new Uint8Array(256256).fill(0x11));
    await disk.formatTrack(5);
    const s = await disk.readSector(5, 1);
    expect(s.every((b) => b === FORMAT_FILL)).toBe(true);
    // a different track is untouched
    const other = await disk.readSector(4, 1);
    expect(other.every((b) => b === 0x11)).toBe(true);
  });

  it('tracks deleted-data marks', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    expect(disk.isDeleted(1, 1)).toBe(false);
    disk.setDeleted(1, 1, true);
    expect(disk.isDeleted(1, 1)).toBe(true);
    await disk.writeSector(1, 1, new Uint8Array(128)); // a fresh write clears it
    expect(disk.isDeleted(1, 1)).toBe(false);
  });

  it('rejects a wrong-sized image', () => {
    expect(() => new InMemoryMdcDioDisk('std-sd', new Uint8Array(100))).toThrow();
  });
});

describe('InMemoryMdcDioDisk with a real IMDOS image', () => {
  const path = join(import.meta.dirname ?? '', '../fixtures/imdos202.dsk');
  it('sector (0,1) matches the raw image head', async () => {
    if (!existsSync(path)) return; // fixture optional
    const bytes = new Uint8Array(readFileSync(path));
    expect(bytes.length).toBe(256256);
    const disk = new InMemoryMdcDioDisk('std-sd', bytes);
    const boot = await disk.readSector(0, 1);
    expect(Array.from(boot)).toEqual(Array.from(bytes.subarray(0, 128)));
  });
});
