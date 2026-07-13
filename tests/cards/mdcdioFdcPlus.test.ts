import { describe, it, expect } from 'vitest';
import type { FdcPlusClient } from '../../src/cards/FdcPlusClient.js';
import { FdcPlusMdcDioDisk } from '../../src/cards/mdcdio/FdcPlusMdcDioDisk.js';

/**
 * Duck-typed stand-in for FdcPlusClient exposing just the two track methods the
 * backend uses. Records calls so we can assert the fdcplus geometry contract:
 * every request uses length = sectors × 128 (3328 for std-SD), and the server's
 * `offset = track × length` then slices a 77×26×128 image correctly.
 */
class FakeClient {
  readonly tracks = new Map<number, Uint8Array>();
  readonly reads: Array<{ drive: number; track: number; length: number }> = [];
  readonly writes: Array<{ drive: number; track: number; length: number }> = [];

  async readTrack(drive: number, track: number, length: number): Promise<Uint8Array> {
    this.reads.push({ drive, track, length });
    const t = this.tracks.get(track);
    return t ? new Uint8Array(t) : new Uint8Array(length);
  }
  async writeTrack(drive: number, track: number, data: Uint8Array): Promise<void> {
    this.writes.push({ drive, track, length: data.length });
    this.tracks.set(track, new Uint8Array(data));
  }
}

function make(drive = 0): { disk: FdcPlusMdcDioDisk; client: FakeClient } {
  const client = new FakeClient();
  const disk = new FdcPlusMdcDioDisk(client as unknown as FdcPlusClient, drive, 'std-sd');
  return { disk, client };
}

describe('FdcPlusMdcDioDisk', () => {
  it('reads a sector by fetching a 3328-byte track and slicing', async () => {
    const { disk, client } = make(2);
    const track = new Uint8Array(3328);
    track[(3 - 1) * 128] = 0xab; // sector 3, byte 0
    track[(3 - 1) * 128 + 127] = 0xcd; // sector 3, byte 127
    client.tracks.set(4, track);

    const s = await disk.readSector(4, 3);
    expect(client.reads).toEqual([{ drive: 2, track: 4, length: 3328 }]);
    expect(s[0]).toBe(0xab);
    expect(s[127]).toBe(0xcd);
  });

  it('caches the current track (one readTrack for two sectors)', async () => {
    const { disk, client } = make();
    await disk.readSector(1, 1);
    await disk.readSector(1, 2);
    expect(client.reads.length).toBe(1);
  });

  it('writes a sector as a read-modify-write of the whole track', async () => {
    const { disk, client } = make(1);
    const data = new Uint8Array(128).fill(0x5c);
    await disk.writeSector(6, 7, data);
    expect(client.writes).toEqual([{ drive: 1, track: 6, length: 3328 }]);
    const written = client.tracks.get(6)!;
    const off = (7 - 1) * 128;
    expect(written[off]).toBe(0x5c);
    expect(written[off + 127]).toBe(0x5c);
  });

  it('formats a track with a 3328-byte E5 buffer', async () => {
    const { disk, client } = make();
    await disk.formatTrack(9);
    expect(client.writes[0]).toEqual({ drive: 0, track: 9, length: 3328 });
    expect(client.tracks.get(9)!.every((b) => b === 0xe5)).toBe(true);
  });

  it('rejects out-of-range track/sector', async () => {
    const { disk } = make();
    await expect(disk.readSector(77, 1)).rejects.toThrow();
    await expect(disk.readSector(0, 27)).rejects.toThrow();
  });
});
