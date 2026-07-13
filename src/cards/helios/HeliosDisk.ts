import { u8 } from '../../util/bits.js';

/**
 * Processor Technology Helios II disk model (Story 5.14).
 *
 * The Helios is firm-sectored: 77 tracks × 16 logical sectors (of 32 hard-sector
 * holes), single density. Data is stored in variable-size *blocks* (1–4095 bytes)
 * that span 1–13 sectors, each block prefixed by a 13-byte header (this/next/prev
 * pointers, file id, length). The controller generates/checks CRC and lays down
 * preamble/sync bytes; none of that is host-visible, so — following Jim Battle's
 * emulation design (HELIOS.EXE) — this model keeps only the header + data bytes.
 *
 * Backing store is the **SVH** ("Solace Virtual Disk, Helios") format:
 *   - 4096-byte header: magic "SVD:Solace Virtual Disk, Helios", then LE u16
 *     version/writeprot/density/sides/tracks(77)/sectors(16) at offset 64, then a
 *     label at offset 1024.
 *   - Then tracks*sectors blocks of 324 bytes: a 4-byte overhead
 *     [fmt, dataLen_lo, dataLen_hi, 0] + 320-byte payload. The 13-byte block
 *     header sits at payload offset 16 (when HAS_HEADER); data at payload offset
 *     48 (when a header is present) else offset 0.
 *
 * See `bios/sol20/helios/README.md` for the full format spec.
 */

export interface HeliosGeometry {
  readonly tracks: number;
  readonly sectors: number;
}

export const HELIOS_GEOMETRY: HeliosGeometry = { tracks: 77, sectors: 16 };

/** Backing store addressed at the controller's level. */
export interface HeliosDisk {
  readonly geometry: HeliosGeometry;
  /** Read `length` data bytes starting at (track, fromSector), flowing across
   * consecutive sectors' data (how the boot reads 832 bytes from track 0). */
  readData(track: number, fromSector: number, length: number): Promise<Uint8Array>;
  /** Write a block of `data` bytes starting at (track, fromSector), split across
   * sectors (first 256, continuations 320) with the appropriate FIRST/LAST flags. */
  writeData(track: number, fromSector: number, data: Uint8Array): Promise<void>;
  /** The 13-byte header of the block that starts at (track, sector). */
  readHeader(track: number, sector: number): Promise<Uint8Array>;
  writeHeader(track: number, sector: number, header: Uint8Array): Promise<void>;
}

// --- SVH format constants (from vdisk_svh_lib.c) ---
export const SVH_MAGIC = 'SVD:Solace Virtual Disk, Helios';
export const SVH_HEADER_SIZE = 4096;
export const SVH_SECSIZE = 320; // payload bytes per sector
export const SVH_SECTOR_OVERHEAD = 4; // [fmt, len_lo, len_hi, 0]
export const SVH_BLKSIZE = SVH_SECSIZE + SVH_SECTOR_OVERHEAD; // 324
export const SVH_HDR_OFFSET = 16; // header start within the payload
export const SVH_DATA_OFFSET = 48; // data start within the payload (when header present)
export const HELIOS_HDRSIZE = 13; // block header bytes

// Per-sector format flags (overhead byte 0).
export const FMT_HAS_HEADER = 0x01;
export const FMT_HAS_DATA = 0x02;
export const FMT_FIRST_DATA = 0x04;
export const FMT_LAST_DATA = 0x08;

/** Data capacity of the first sector of a block (the rest of the 320 bytes is
 * consumed by the header region); continuation sectors carry the full 320. */
const FIRST_SECTOR_DATA = 256;

interface SectorRecord {
  fmt: number;
  header: Uint8Array; // 13 bytes
  data: Uint8Array; // dataBytes long
}

export class HeliosRangeError extends Error {
  constructor(message: string, readonly kind: 'track' | 'sector') {
    super(message);
    this.name = 'HeliosRangeError';
  }
}

/**
 * In-memory Helios disk, optionally initialized from an SVH image. A blank disk
 * has every sector formatted as an all-0xFF header + a single 0xFF data byte
 * (matching a freshly formatted Helios sector).
 */
export class InMemoryHeliosDisk implements HeliosDisk {
  readonly geometry: HeliosGeometry;
  private readonly sectors: SectorRecord[]; // [track*16 + sector]
  private label = '';

  constructor(geometry: HeliosGeometry = HELIOS_GEOMETRY) {
    this.geometry = geometry;
    const n = geometry.tracks * geometry.sectors;
    this.sectors = new Array(n);
    for (let i = 0; i < n; i++) this.sectors[i] = this.blankSector();
  }

  private blankSector(): SectorRecord {
    return { fmt: 0, header: new Uint8Array(HELIOS_HDRSIZE).fill(0xff), data: new Uint8Array([0xff]) };
  }

  private idx(track: number, sector: number): number {
    if (track < 0 || track >= this.geometry.tracks) {
      throw new HeliosRangeError(`track ${track} out of range`, 'track');
    }
    if (sector < 0 || sector >= this.geometry.sectors) {
      throw new HeliosRangeError(`sector ${sector} out of range`, 'sector');
    }
    return track * this.geometry.sectors + sector;
  }

  async readData(track: number, fromSector: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    let n = 0;
    for (let s = fromSector; s < this.geometry.sectors && n < length; s++) {
      const rec = this.sectors[this.idx(track, s)]!;
      const take = Math.min(rec.data.length, length - n);
      out.set(rec.data.subarray(0, take), n);
      n += take;
    }
    // Short reads (past the recorded data) read as the format fill.
    if (n < length) out.fill(0xff, n);
    return out;
  }

  async writeData(track: number, fromSector: number, data: Uint8Array): Promise<void> {
    let off = 0;
    let s = fromSector;
    let first = true;
    while (off < data.length && s < this.geometry.sectors) {
      const cap = first ? FIRST_SECTOR_DATA : SVH_SECSIZE;
      const take = Math.min(cap, data.length - off);
      const rec = this.sectors[this.idx(track, s)]!;
      rec.data = data.slice(off, off + take);
      rec.fmt = FMT_HAS_DATA | (first ? FMT_FIRST_DATA | FMT_HAS_HEADER : 0);
      off += take;
      first = false;
      s++;
    }
    if (s > fromSector) this.sectors[this.idx(track, s - 1)]!.fmt |= FMT_LAST_DATA;
  }

  async readHeader(track: number, sector: number): Promise<Uint8Array> {
    return this.sectors[this.idx(track, sector)]!.header.slice();
  }

  async writeHeader(track: number, sector: number, header: Uint8Array): Promise<void> {
    const rec = this.sectors[this.idx(track, sector)]!;
    rec.header = new Uint8Array(HELIOS_HDRSIZE);
    for (let i = 0; i < HELIOS_HDRSIZE; i++) rec.header[i] = u8(header[i] ?? 0xff);
    rec.fmt |= FMT_HAS_HEADER;
  }

  /** Disk label from the SVH header (informational). */
  get diskLabel(): string {
    return this.label;
  }

  // --- SVH (de)serialization ---

  /** Build an in-memory disk from a `.svh` image. */
  static fromSvh(image: Uint8Array): InMemoryHeliosDisk {
    const magic = new TextDecoder('latin1').decode(image.subarray(0, SVH_MAGIC.length));
    if (magic !== SVH_MAGIC) throw new Error(`not an SVH image (magic="${magic}")`);
    const u16 = (o: number): number => image[o]! | (image[o + 1]! << 8);
    const tracks = u16(64 + 8);
    const sectors = u16(64 + 10);
    const disk = new InMemoryHeliosDisk({ tracks, sectors });
    disk.label = new TextDecoder('latin1').decode(image.subarray(1024, 1024 + 256)).split('\0')[0]!.trim();
    for (let t = 0; t < tracks; t++) {
      for (let s = 0; s < sectors; s++) {
        const base = SVH_HEADER_SIZE + (t * sectors + s) * SVH_BLKSIZE;
        const fmt = image[base]!;
        const dataBytes = image[base + 1]! | (image[base + 2]! << 8);
        const payload = base + SVH_SECTOR_OVERHEAD;
        const rec = disk.sectors[t * sectors + s]!;
        rec.fmt = fmt;
        if (fmt & FMT_HAS_HEADER) {
          rec.header = image.slice(payload + SVH_HDR_OFFSET, payload + SVH_HDR_OFFSET + HELIOS_HDRSIZE);
        }
        const dataOff = payload + ((fmt & FMT_HAS_HEADER) ? SVH_DATA_OFFSET : 0);
        rec.data = image.slice(dataOff, dataOff + dataBytes);
      }
    }
    return disk;
  }

  /** Serialize to a `.svh` image. */
  toSvh(): Uint8Array {
    const { tracks, sectors } = this.geometry;
    const out = new Uint8Array(SVH_HEADER_SIZE + tracks * sectors * SVH_BLKSIZE);
    const enc = new TextEncoder();
    out.set(enc.encode(SVH_MAGIC), 0);
    const putU16 = (o: number, v: number): void => { out[o] = v & 0xff; out[o + 1] = (v >> 8) & 0xff; };
    putU16(64, 1); // version
    putU16(64 + 2, 0); // writeprot
    putU16(64 + 4, 1); // density
    putU16(64 + 6, 1); // sides
    putU16(64 + 8, tracks);
    putU16(64 + 10, sectors);
    out.set(enc.encode(this.label), 1024);
    for (let t = 0; t < tracks; t++) {
      for (let s = 0; s < sectors; s++) {
        const rec = this.sectors[t * sectors + s]!;
        const base = SVH_HEADER_SIZE + (t * sectors + s) * SVH_BLKSIZE;
        out[base] = rec.fmt & 0xff;
        out[base + 1] = rec.data.length & 0xff;
        out[base + 2] = (rec.data.length >> 8) & 0xff;
        const payload = base + SVH_SECTOR_OVERHEAD;
        if (rec.fmt & FMT_HAS_HEADER) out.set(rec.header.subarray(0, HELIOS_HDRSIZE), payload + SVH_HDR_OFFSET);
        const dataOff = payload + ((rec.fmt & FMT_HAS_HEADER) ? SVH_DATA_OFFSET : 0);
        out.set(rec.data.subarray(0, Math.min(rec.data.length, SVH_SECSIZE - (dataOff - payload))), dataOff);
      }
    }
    return out;
  }
}
