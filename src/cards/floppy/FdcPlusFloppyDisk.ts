import type { FdcPlusClient } from '../FdcPlusClient.js';
import { u8 } from '../../util/bits.js';
import {
  GEOMETRIES,
  type GeometrySpec,
  type FloppyDisk,
  type FloppyGeometry,
  FloppyRangeError,
  FORMAT_FILL,
  SECTOR_SIZE,
  trackLength,
} from './FloppyDisk.js';

/**
 * Floppy backend served over the fdcplus-web WebSocket protocol — the same
 * transport `MitsDcddCard` uses. One instance wraps one drive on a shared
 * {@link FdcPlusClient}. Used by both the MDC-DIO and FIF controllers.
 *
 * fdcplus-web reads/writes a track at `offset = track * length` using the
 * *client-supplied* length (drive.ts), so requesting `sectors × 128` (3328 for
 * std-SD) slices a 77×26×128 IMSAI image correctly with no server change — as
 * long as the image is mounted on the server as this drive.
 *
 * Sectors are served by fetching (and caching) the whole physical track, then
 * slicing; a write is a read-modify-write of the cached track followed by a
 * `writeTrack`. The FDC+ format has no deleted-data marks, so those are tracked
 * locally for session consistency only.
 */
export class FdcPlusFloppyDisk implements FloppyDisk {
  readonly geometry: GeometrySpec;
  private readonly trackLen: number;
  private cachedTrack = -1;
  private trackBuf: Uint8Array | null = null;
  private readonly deleted = new Set<number>(); // track*sectors + (sector-1)

  constructor(
    private readonly client: FdcPlusClient,
    private readonly drive: number,
    geometry: FloppyGeometry | GeometrySpec = 'std-sd',
  ) {
    this.geometry = typeof geometry === 'string' ? GEOMETRIES[geometry] : geometry;
    this.trackLen = trackLength(this.geometry);
  }

  async readSector(track: number, sector: number): Promise<Uint8Array> {
    this.assertRange(track, sector);
    const buf = await this.ensureTrack(track);
    const off = (sector - 1) * SECTOR_SIZE;
    return buf.slice(off, off + SECTOR_SIZE);
  }

  async writeSector(track: number, sector: number, data: Uint8Array): Promise<void> {
    this.assertRange(track, sector);
    const buf = await this.ensureTrack(track);
    const off = (sector - 1) * SECTOR_SIZE;
    for (let i = 0; i < SECTOR_SIZE; i++) buf[off + i] = u8(data[i] ?? 0);
    await this.client.writeTrack(this.drive, track, buf);
    this.deleted.delete(this.flag(track, sector));
  }

  async formatTrack(track: number): Promise<void> {
    this.assertRange(track);
    const buf = new Uint8Array(this.trackLen).fill(FORMAT_FILL);
    await this.client.writeTrack(this.drive, track, buf);
    this.cachedTrack = track;
    this.trackBuf = buf;
    for (let s = 1; s <= this.geometry.sectors; s++) this.deleted.delete(this.flag(track, s));
  }

  isDeleted(track: number, sector: number): boolean {
    return this.deleted.has(this.flag(track, sector));
  }

  setDeleted(track: number, sector: number, deleted: boolean): void {
    const f = this.flag(track, sector);
    if (deleted) this.deleted.add(f);
    else this.deleted.delete(f);
  }

  private async ensureTrack(track: number): Promise<Uint8Array> {
    if (this.cachedTrack !== track || !this.trackBuf) {
      this.trackBuf = await this.client.readTrack(this.drive, track, this.trackLen);
      this.cachedTrack = track;
    }
    return this.trackBuf;
  }

  private flag(track: number, sector: number): number {
    return track * this.geometry.sectors + (sector - 1);
  }

  private assertRange(track: number, sector?: number): void {
    if (track < 0 || track >= this.geometry.tracks) {
      throw new FloppyRangeError(`track ${track} out of range`, 'track');
    }
    if (sector !== undefined && (sector < 1 || sector > this.geometry.sectors)) {
      throw new FloppyRangeError(`sector ${sector} out of range`, 'sector');
    }
  }
}
