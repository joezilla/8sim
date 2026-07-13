import type { FdcPlusClient } from '../FdcPlusClient.js';
import { u8 } from '../../util/bits.js';
import {
  type HeliosDisk,
  type HeliosGeometry,
  HELIOS_GEOMETRY,
  HELIOS_HDRSIZE,
  HeliosRangeError,
  SVH_BLKSIZE,
  SVH_SECTOR_OVERHEAD,
  SVH_HDR_OFFSET,
  SVH_DATA_OFFSET,
  SVH_SECSIZE,
  FMT_HAS_HEADER,
  FMT_HAS_DATA,
  FMT_FIRST_DATA,
  FMT_LAST_DATA,
} from './HeliosDisk.js';

const FIRST_SECTOR_DATA = 256;

/**
 * Helios disk backend served over the fdcplus-web protocol (Story 5.14). One
 * instance wraps one unit on a shared {@link FdcPlusClient}. Unlike the FIF's
 * 128-byte sectors, a Helios "track" is the raw SVH block region for that track:
 * `sectors × SVH_BLKSIZE` = 16 × 324 = 5184 bytes, laid out as
 * `[fmt, dataLen_lo, dataLen_hi, 0][320-byte payload]` per sector (header at
 * payload+16, data at payload+48 when a header is present).
 *
 * The server must therefore hold the disk as raw per-track SVH block data
 * (offset = track × 5184, no 4 KB SVD header). Reads fetch + cache the whole
 * track and parse sectors locally; writes are read-modify-write of the track.
 */
export class FdcPlusHeliosDisk implements HeliosDisk {
  readonly geometry: HeliosGeometry;
  private readonly trackLen: number;
  private cachedTrack = -1;
  private trackBuf: Uint8Array | null = null;

  constructor(
    private readonly client: FdcPlusClient,
    private readonly unit: number,
    geometry: HeliosGeometry = HELIOS_GEOMETRY,
  ) {
    this.geometry = geometry;
    this.trackLen = geometry.sectors * SVH_BLKSIZE;
  }

  private assertRange(track: number, sector?: number): void {
    if (track < 0 || track >= this.geometry.tracks) throw new HeliosRangeError(`track ${track} out of range`, 'track');
    if (sector !== undefined && (sector < 0 || sector >= this.geometry.sectors)) {
      throw new HeliosRangeError(`sector ${sector} out of range`, 'sector');
    }
  }

  private async ensureTrack(track: number): Promise<Uint8Array> {
    if (this.cachedTrack !== track || !this.trackBuf) {
      this.trackBuf = await this.client.readTrack(this.unit, track, this.trackLen);
      this.cachedTrack = track;
    }
    return this.trackBuf;
  }

  private blockBase(sector: number): number {
    return sector * SVH_BLKSIZE;
  }

  /** Data bytes stored in one sector's block. */
  private sectorData(buf: Uint8Array, sector: number): Uint8Array {
    const base = this.blockBase(sector);
    const fmt = buf[base]!;
    const dataBytes = buf[base + 1]! | (buf[base + 2]! << 8);
    const payload = base + SVH_SECTOR_OVERHEAD;
    const dataOff = payload + ((fmt & FMT_HAS_HEADER) ? SVH_DATA_OFFSET : 0);
    return buf.slice(dataOff, dataOff + dataBytes);
  }

  async readData(track: number, fromSector: number, length: number): Promise<Uint8Array> {
    this.assertRange(track, fromSector);
    const buf = await this.ensureTrack(track);
    const out = new Uint8Array(length);
    let n = 0;
    for (let s = fromSector; s < this.geometry.sectors && n < length; s++) {
      const d = this.sectorData(buf, s);
      const take = Math.min(d.length, length - n);
      out.set(d.subarray(0, take), n);
      n += take;
    }
    if (n < length) out.fill(0xff, n);
    return out;
  }

  async writeData(track: number, fromSector: number, data: Uint8Array): Promise<void> {
    this.assertRange(track, fromSector);
    const buf = await this.ensureTrack(track);
    let off = 0;
    let s = fromSector;
    let first = true;
    while (off < data.length && s < this.geometry.sectors) {
      const cap = first ? FIRST_SECTOR_DATA : SVH_SECSIZE;
      const take = Math.min(cap, data.length - off);
      const base = this.blockBase(s);
      const fmt = FMT_HAS_DATA | (first ? FMT_FIRST_DATA | FMT_HAS_HEADER : 0);
      buf[base] = fmt;
      buf[base + 1] = take & 0xff;
      buf[base + 2] = (take >> 8) & 0xff;
      const payload = base + SVH_SECTOR_OVERHEAD;
      const dataOff = payload + (first ? SVH_DATA_OFFSET : 0);
      for (let i = 0; i < take; i++) buf[dataOff + i] = u8(data[off + i] ?? 0);
      off += take;
      first = false;
      s++;
    }
    if (s > fromSector) buf[this.blockBase(s - 1)]! |= FMT_LAST_DATA;
    await this.client.writeTrack(this.unit, track, buf);
  }

  async readHeader(track: number, sector: number): Promise<Uint8Array> {
    this.assertRange(track, sector);
    const buf = await this.ensureTrack(track);
    const payload = this.blockBase(sector) + SVH_SECTOR_OVERHEAD;
    return buf.slice(payload + SVH_HDR_OFFSET, payload + SVH_HDR_OFFSET + HELIOS_HDRSIZE);
  }

  async writeHeader(track: number, sector: number, header: Uint8Array): Promise<void> {
    this.assertRange(track, sector);
    const buf = await this.ensureTrack(track);
    const base = this.blockBase(sector);
    buf[base]! |= FMT_HAS_HEADER;
    const payload = base + SVH_SECTOR_OVERHEAD;
    for (let i = 0; i < HELIOS_HDRSIZE; i++) buf[payload + SVH_HDR_OFFSET + i] = u8(header[i] ?? 0xff);
    await this.client.writeTrack(this.unit, track, buf);
  }
}
