import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { FdcPlusClient, type WebSocketLike } from './FdcPlusClient.js';

const TRACK_LEN   = 137 * 32; // 4384 bytes — one full 8-inch track
const BYTES_PER_SECTOR = 137;
const MAX_TRACK   = 76;

export interface DcddOptions {
  readonly basePort?: number; // default 0x08
}

export class MitsDcddCard implements IS100Card, IIODevice {
  readonly id: string;
  readonly basePorts: ReadonlyArray<number>;

  private readonly fdcClient: FdcPlusClient;
  private readonly p1: number;
  private readonly p2: number;
  private readonly p3: number;

  private selectedDrive = 0xFF;
  // Head position is PER-DRIVE state: each drive's arm stays where it was
  // left. The BIOS seeks relatively from a per-drive track table in RAM, so a
  // single shared counter desyncs the moment two drives interleave seeks
  // (e.g. PIP copying between disks) and lands reads/writes on wrong tracks.
  private readonly driveTrack: number[] = new Array(16).fill(0);
  private headLoaded    = false;
  private writeEnabled  = false;
  private fetchPending  = false;
  private trackData:    Uint8Array | null = null;
  private writeBuffer:  Uint8Array | null = null;
  private writtenSectors = new Set<number>(); // sectors touched since Write Enable
  private writeDirty    = false;
  private lastSector    = -1;
  private byteInSector  = 0;
  private cacheDrive    = 0xFF; // which drive the cached trackData belongs to

  /** Head position of the currently selected drive (0 when none selected). */
  private get currentTrack(): number {
    return this.selectedDrive === 0xFF ? 0 : (this.driveTrack[this.selectedDrive] ?? 0);
  }

  private set currentTrack(track: number) {
    if (this.selectedDrive !== 0xFF) this.driveTrack[this.selectedDrive] = track;
  }

  constructor(id: string, ws: WebSocketLike, options: DcddOptions = {}) {
    this.id = id;
    const base = options.basePort ?? 0x08;
    this.p1 = base;
    this.p2 = base + 1;
    this.p3 = base + 2;
    this.basePorts = [this.p1, this.p2, this.p3];
    this.fdcClient = new FdcPlusClient(ws);
  }

  attach(bus: Bus): void {
    bus.attachIODevice(this);
  }

  ioRead(port: number): number {
    if (port === this.p1) return this.readStatus();
    if (port === this.p2) return this.readSector();
    if (port === this.p3) return this.readData();
    return 0xff;
  }

  ioWrite(port: number, value: number): void {
    if (port === this.p1) { this.writeDriveSelect(value); return; }
    if (port === this.p2) { this.writeCommand(value); return; }
    if (port === this.p3) { this.writeData(value); return; }
  }

  reset(): void {
    this.flushWrite();
    this.selectedDrive = 0xFF;
    this.driveTrack.fill(0);
    this.headLoaded    = false;
    this.writeEnabled  = false;
    this.fetchPending  = false;
    this.trackData     = null;
    this.writeBuffer   = null;
    this.writtenSectors.clear();
    this.writeDirty    = false;
    this.lastSector    = -1;
    this.byteInSector  = 0;
    this.cacheDrive    = 0xFF;
  }

  // --- Port 1: status (READ) / drive select (WRITE) ---

  private readStatus(): number {
    this.ensureTrack(); // lazily (re)start a fetch if the current track isn't cached
    // 88-DCDD status register, all bits active-low (0 = condition true):
    //   bit7 NRDA   — new read data available
    //   bit6 TRK0   — head at track 0
    //   bit3 DRVRDY — drive ready (a drive is selected and its disk is present)
    //   bit2 HDSTAT — head loaded / positioning valid
    //   bit1 MVHEAD — head movement complete (instantaneous in emulation)
    //   bit0 ENWDAT — ready to accept write data
    const nrda   = (!this.headLoaded || !this.trackData || this.fetchPending) ? 0x80 : 0;
    const trk0   = this.currentTrack === 0 ? 0x00 : 0x40;
    const drvrdy = this.selectedDrive !== 0xFF ? 0x00 : 0x08;
    const hdstat = this.headLoaded ? 0x00 : 0x04;
    const mvhd   = 0x00;
    const enwd   = this.writeEnabled ? 0x00 : 0x01;
    return nrda | trk0 | drvrdy | hdstat | mvhd | enwd;
  }

  private writeDriveSelect(value: number): void {
    if ((value & 0x80) !== 0) {
      // Disable/deselect the drive. On real hardware this drops the drive-enable
      // line but the head-load solenoid and the data already under the head are
      // physical state that persists — the drive can be reselected with the head
      // still loaded. The MITS multi-stage boot relies on exactly this (it
      // reselects the drive and expects HEDLD to already be active). Only an
      // explicit Head Unload command (Port 2 bit 3) lifts the head.
      this.flushWrite();
      this.selectedDrive = 0xFF;
      this.writeEnabled  = false;
      return;
    }
    const drive = value & 0x0F;
    // A dirty write buffer belongs to the drive we're switching away from —
    // flush it before the selection changes, or it lands on the new drive.
    if (drive !== this.selectedDrive) this.flushWrite();
    this.selectedDrive = drive;
    // Selecting a different drive invalidates the cached track (different disk).
    if (drive !== this.cacheDrive) {
      this.trackData = null;
    }
    this.ensureTrack();
    this.fdcClient
      .stat(this.selectedDrive, this.headLoaded, this.currentTrack)
      .catch(() => {});
  }

  // --- Port 2: sector position (READ) / command (WRITE) ---

  private readSector(): number {
    const revMs  = 166.667;
    const secMs  = revMs / 32;
    const pos    = performance.now() % revMs;
    const sector = Math.floor(pos / secMs) & 0x1F;
    const offset = pos % secMs;

    // Sector True (bit 0) pulses LOW for first 1 ms of each sector window
    const sectorTrue = offset < 1.0 ? 0 : 1;

    if (sector !== this.lastSector || sectorTrue === 0) {
      // New sector under the head, or the start-of-sector pulse. Sector True
      // marks the beginning of the sector: software that samples it here (the
      // BIOS waits for it before every transfer) expects the byte stream to
      // start at byte 0 — even when re-targeting the sector it just finished,
      // where the sector number alone wouldn't change.
      this.lastSector   = sector;
      this.byteInSector = 0;
    }
    return 0xC0 | ((sector & 0x1F) << 1) | sectorTrue;
  }

  private writeCommand(value: number): void {
    // Process all command bits; multiple may be set simultaneously
    if ((value & 0x80) !== 0) { // Write Enable
      // The BIOS issues Write Enable once per sector write. On real hardware
      // each sector hits the disk immediately; here writes accumulate in the
      // track buffer until flush, so Write Enable must NOT discard sectors
      // buffered by earlier enables — only ensure a buffer exists.
      this.writeEnabled = true;
      if (!this.writeBuffer) this.writeBuffer = new Uint8Array(TRACK_LEN);
    }
    if ((value & 0x08) !== 0) { // Head Unload
      this.flushWrite();
      this.headLoaded = false;
      this.trackData  = null;
    }
    if ((value & 0x04) !== 0) { // Head Load
      this.headLoaded = true;
      this.ensureTrack();
    }
    if ((value & 0x02) !== 0) this.issueStep('out'); // Step Out
    if ((value & 0x01) !== 0) this.issueStep('in');  // Step In
  }

  // --- Port 3: data (READ/WRITE) ---

  private readData(): number {
    if (!this.headLoaded || !this.trackData || this.fetchPending) return 0xff;
    // Past the 137th byte the head is over the inter-sector gap — nothing to
    // read until the sector counter advances (which resets byteInSector).
    if (this.byteInSector >= BYTES_PER_SECTOR) return 0xff;
    const sector = this.lastSector < 0 ? 0 : this.lastSector;
    const offset = sector * BYTES_PER_SECTOR + this.byteInSector;
    // A sector rewritten since Write Enable reads back its new contents.
    const source = (this.writeBuffer && this.writtenSectors.has(sector))
      ? this.writeBuffer
      : this.trackData;
    if (offset >= source.length) return 0xff;
    const byte = source[offset] ?? 0xff;
    this.byteInSector++;
    return byte;
  }

  private writeData(value: number): void {
    if (!this.writeEnabled || !this.writeBuffer) return;
    // The BIOS pads its 137-byte sector burst with trailing bytes; on real
    // hardware they land in the inter-sector gap. Discard them — wrapping
    // around would overwrite the start of the sector (the track-marker byte),
    // corrupting it.
    if (this.byteInSector >= BYTES_PER_SECTOR) return;
    const sector = this.lastSector < 0 ? 0 : this.lastSector;
    const offset = sector * BYTES_PER_SECTOR + this.byteInSector;
    if (offset < this.writeBuffer.length) {
      this.writeBuffer[offset] = value & 0xff;
      this.writtenSectors.add(sector);
      this.writeDirty = true;
    }
    this.byteInSector++;
  }

  // --- Private helpers ---

  /**
   * Start fetching the current track if the head is loaded, a drive is
   * selected, we don't already have the data, and no fetch is in flight. Safe
   * to call from any read/command path — it converges on caching the track the
   * head is currently over.
   */
  private ensureTrack(): void {
    if (!this.headLoaded || this.selectedDrive === 0xFF) return;
    if (this.trackData || this.fetchPending) return;
    this.fetchTrack();
  }

  private fetchTrack(): void {
    if (this.selectedDrive === 0xFF || !this.headLoaded || this.fetchPending) return;
    this.fetchPending = true;
    const drive = this.selectedDrive;
    const track = this.currentTrack;
    this.fdcClient
      .readTrack(drive, track, TRACK_LEN)
      .then((data) => {
        // Only install the data if the head hasn't moved (and the same drive is
        // still selected) since the fetch began — otherwise it belongs to a
        // track we're no longer over and would corrupt the next read. A cache
        // that appeared meanwhile is a flushed write image, which is fresher
        // than what we just fetched — keep it.
        if (track === this.currentTrack && drive === this.selectedDrive && !this.trackData) {
          this.trackData = data;
          this.cacheDrive = drive;
        }
      })
      .catch(() => {})
      .finally(() => {
        this.fetchPending = false;
        // If the head moved during the fetch, chase the track it's now over.
        this.ensureTrack();
      });
  }

  private flushWrite(): void {
    if (!this.writeDirty || !this.writeBuffer || this.selectedDrive === 0xFF) return;
    // WRIT replaces the whole track on the server, but the program only wrote
    // some sectors — merge those over the cached track image so the rest keep
    // their contents.
    const image = this.trackData ? new Uint8Array(this.trackData) : new Uint8Array(TRACK_LEN);
    for (const sector of this.writtenSectors) {
      const off = sector * BYTES_PER_SECTOR;
      image.set(this.writeBuffer.subarray(off, off + BYTES_PER_SECTOR), off);
    }
    const drive = this.selectedDrive;
    const track = this.currentTrack;
    this.writeBuffer  = null;
    this.writtenSectors.clear();
    this.writeDirty   = false;
    this.writeEnabled = false;
    // The merged image is now the freshest copy of the track — reads must see
    // the written data, not the pre-write cache.
    this.trackData  = image;
    this.cacheDrive = drive;
    this.fdcClient.writeTrack(drive, track, image).catch((e) => {
      console.error(`[${this.id}] track write failed (drive ${drive}, track ${track}): ${String(e)}`);
    });
  }

  private issueStep(dir: 'in' | 'out'): void {
    // Seeks are instantaneous in emulation. A real-time settle delay would
    // desync from the emulated CPU (which the software paces itself), and
    // dropping "too-fast" step pulses would lose track position entirely.
    this.flushWrite(); // a dirty buffer belongs to the track we're leaving
    if (dir === 'in')  this.currentTrack = Math.min(MAX_TRACK, this.currentTrack + 1);
    else               this.currentTrack = Math.max(0, this.currentTrack - 1);
    this.trackData    = null; // head moved; cached track is no longer under it
    this.writeEnabled = false;
    this.ensureTrack();       // begin fetching the new track
  }
}
