import { u8 } from '../../util/bits.js';

/**
 * Shared floppy-disk backend abstraction for the IMSAI controllers (MDC-DIO and
 * FIF) — both address IBM-3740 media by (track, 1-based sector), 128 bytes per
 * sector. The controller sees *physical* sectors — the booted OS's BIOS does the
 * logical→physical skew, not us — so a flat `.dsk` image is stored in physical
 * order and indexed as
 *
 *   offset = (track * sectorsPerTrack + (sector - 1)) * 128
 *
 * The interface is async-uniform (every method returns a Promise) so the same
 * command path serves an in-process image (resolves immediately) and the
 * fdcplus-web WebSocket backend (resolves when a track arrives). See
 * {@link InMemoryFloppyDisk} and `FdcPlusFloppyDisk`.
 */
export type FloppyGeometry = 'std-sd' | 'std-dd' | 'mini';

export interface GeometrySpec {
  /** Number of tracks (0..tracks-1). */
  readonly tracks: number;
  /** Sectors per track (1..sectors on the wire). */
  readonly sectors: number;
  /** Always 128 for every supported format. */
  readonly bytesPerSector: 128;
}

/** Supported formats. All z80pack IMSAI images are std-sd (77×26×128 = 256,256
 * bytes, IBM 3740). */
export const GEOMETRIES: Record<FloppyGeometry, GeometrySpec> = {
  'std-sd': { tracks: 77, sectors: 26, bytesPerSector: 128 },
  'std-dd': { tracks: 77, sectors: 58, bytesPerSector: 128 },
  mini: { tracks: 35, sectors: 18, bytesPerSector: 128 },
};

export const SECTOR_SIZE = 128;
/** Format fill byte laid down by FORMAT TRACK / fresh images (CP/M's E5). */
export const FORMAT_FILL = 0xe5;

/** Bytes in a full flat image for a geometry. */
export function imageSize(geo: GeometrySpec): number {
  return geo.tracks * geo.sectors * SECTOR_SIZE;
}

/** Bytes in one physical track (used as the fdcplus track length). */
export function trackLength(geo: GeometrySpec): number {
  return geo.sectors * SECTOR_SIZE;
}

/** Raised for an out-of-range track/sector so an interpreter can map it to the
 * controller's illegal-track / illegal-sector status code. */
export class FloppyRangeError extends Error {
  constructor(
    message: string,
    readonly kind: 'track' | 'sector',
  ) {
    super(message);
    this.name = 'FloppyRangeError';
  }
}

/** A pluggable disk backing store, addressed by physical (track, 1-based sector). */
export interface FloppyDisk {
  readonly geometry: GeometrySpec;
  /** Resolve to a fresh 128-byte copy of the sector. Rejects with
   * {@link FloppyRangeError} for an out-of-range address. */
  readSector(track: number, sector: number): Promise<Uint8Array>;
  /** Write 128 bytes to the sector. */
  writeSector(track: number, sector: number, data: Uint8Array): Promise<void>;
  /** Overwrite an entire track with the format fill byte. */
  formatTrack(track: number): Promise<void>;
  /** Whether the sector carries a deleted-data address mark. */
  isDeleted(track: number, sector: number): boolean;
  setDeleted(track: number, sector: number, deleted: boolean): void;
}

function assertRange(geo: GeometrySpec, track: number, sector?: number): void {
  if (track < 0 || track >= geo.tracks) {
    throw new FloppyRangeError(`track ${track} out of range 0..${geo.tracks - 1}`, 'track');
  }
  if (sector !== undefined && (sector < 1 || sector > geo.sectors)) {
    throw new FloppyRangeError(`sector ${sector} out of range 1..${geo.sectors}`, 'sector');
  }
}

function sectorOffset(geo: GeometrySpec, track: number, sector: number): number {
  return (track * geo.sectors + (sector - 1)) * SECTOR_SIZE;
}

/**
 * In-process disk backed by a flat `.dsk` byte array (physical sector order).
 * Loads a z80pack IMSAI image directly. Pure `Uint8Array` — no Node builtins,
 * so it runs in `src/`, the browser, and tests alike. Deleted-data marks are
 * tracked in a parallel flag array (a flat `.dsk` has nowhere to store the AM
 * type); they reset when the image is reloaded.
 */
export class InMemoryFloppyDisk implements FloppyDisk {
  readonly geometry: GeometrySpec;
  private readonly data: Uint8Array;
  private readonly deleted: Uint8Array; // one flag per (track*sectors + sector-1)

  /**
   * @param geometry  format name or a full spec
   * @param image     optional initial image; must equal the geometry's image
   *                  size. When omitted, an all-`E5` blank disk is allocated.
   */
  constructor(geometry: FloppyGeometry | GeometrySpec, image?: Uint8Array) {
    this.geometry = typeof geometry === 'string' ? GEOMETRIES[geometry] : geometry;
    const size = imageSize(this.geometry);
    if (image) {
      if (image.length !== size) {
        throw new Error(
          `floppy disk image is ${image.length} bytes, expected ${size} for this geometry`,
        );
      }
      this.data = new Uint8Array(image); // copy — caller keeps its buffer
    } else {
      this.data = new Uint8Array(size).fill(FORMAT_FILL);
    }
    this.deleted = new Uint8Array(this.geometry.tracks * this.geometry.sectors);
  }

  readSector(track: number, sector: number): Promise<Uint8Array> {
    try {
      assertRange(this.geometry, track, sector);
    } catch (e) {
      return Promise.reject(e);
    }
    const off = sectorOffset(this.geometry, track, sector);
    return Promise.resolve(this.data.slice(off, off + SECTOR_SIZE));
  }

  writeSector(track: number, sector: number, data: Uint8Array): Promise<void> {
    try {
      assertRange(this.geometry, track, sector);
    } catch (e) {
      return Promise.reject(e);
    }
    const off = sectorOffset(this.geometry, track, sector);
    for (let i = 0; i < SECTOR_SIZE; i++) this.data[off + i] = u8(data[i] ?? 0);
    this.setDeleted(track, sector, false);
    return Promise.resolve();
  }

  formatTrack(track: number): Promise<void> {
    try {
      assertRange(this.geometry, track);
    } catch (e) {
      return Promise.reject(e);
    }
    const off = track * this.geometry.sectors * SECTOR_SIZE;
    this.data.fill(FORMAT_FILL, off, off + this.geometry.sectors * SECTOR_SIZE);
    for (let s = 1; s <= this.geometry.sectors; s++) this.setDeleted(track, s, false);
    return Promise.resolve();
  }

  isDeleted(track: number, sector: number): boolean {
    assertRange(this.geometry, track, sector);
    return this.deleted[track * this.geometry.sectors + (sector - 1)] !== 0;
  }

  setDeleted(track: number, sector: number, deleted: boolean): void {
    assertRange(this.geometry, track, sector);
    this.deleted[track * this.geometry.sectors + (sector - 1)] = deleted ? 1 : 0;
  }

  /** Serialize back to a flat `.dsk` image (fresh copy) for persistence. */
  toBytes(): Uint8Array {
    return new Uint8Array(this.data);
  }
}
