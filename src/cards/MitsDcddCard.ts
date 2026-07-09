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
  private currentTrack  = 0;
  private headLoaded    = false;
  private headMoving    = false;
  private writeEnabled  = false;
  private fetchPending  = false;
  private trackData:    Uint8Array | null = null;
  private writeBuffer:  Uint8Array | null = null;
  private writeDirty    = false;
  private lastSector    = -1;
  private byteInSector  = 0;
  private cacheDrive    = 0xFF; // which drive the cached trackData belongs to

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
    this.currentTrack  = 0;
    this.headLoaded    = false;
    this.headMoving    = false;
    this.writeEnabled  = false;
    this.fetchPending  = false;
    this.trackData     = null;
    this.writeBuffer   = null;
    this.writeDirty    = false;
    this.lastSector    = -1;
    this.byteInSector  = 0;
    this.cacheDrive    = 0xFF;
  }

  // --- Port 1: status (READ) / drive select (WRITE) ---

  private readStatus(): number {
    const nrda  = (!this.headLoaded || !this.trackData || this.fetchPending) ? 0x80 : 0;
    const trk0  = this.currentTrack === 0 ? 0x00 : 0x40;
    const hedld = this.headLoaded ? 0x00 : 0x08;
    const hd    = this.headLoaded ? 0x00 : 0x04;
    const mvhd  = this.headMoving  ? 0x02 : 0x00;
    const enwd  = this.writeEnabled ? 0x00 : 0x01;
    return nrda | trk0 | hedld | hd | mvhd | enwd;
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
    this.selectedDrive = drive;
    // Selecting a different drive invalidates the cached track (different disk).
    if (drive !== this.cacheDrive) {
      this.trackData = null;
      if (this.headLoaded) this.fetchTrack();
    }
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

    if (sector !== this.lastSector) {
      this.lastSector   = sector;
      this.byteInSector = 0;
    }

    // Sector True (bit 0) pulses LOW for first 1 ms of each sector window
    const sectorTrue = offset < 1.0 ? 0 : 1;
    return 0xC0 | ((sector & 0x1F) << 1) | sectorTrue;
  }

  private writeCommand(value: number): void {
    // Process all command bits; multiple may be set simultaneously
    if ((value & 0x80) !== 0) { // Write Enable
      this.writeEnabled = true;
      this.writeBuffer  = new Uint8Array(TRACK_LEN);
      this.writeDirty   = false;
    }
    if ((value & 0x08) !== 0) { // Head Unload
      this.flushWrite();
      this.headLoaded = false;
      this.trackData  = null;
    }
    if ((value & 0x04) !== 0) { // Head Load
      this.headLoaded = true;
      if (this.selectedDrive !== 0xFF) this.fetchTrack();
    }
    if ((value & 0x02) !== 0) this.issueStep('out'); // Step Out
    if ((value & 0x01) !== 0) this.issueStep('in');  // Step In
  }

  // --- Port 3: data (READ/WRITE) ---

  private readData(): number {
    if (!this.headLoaded || !this.trackData || this.fetchPending) return 0xff;
    const sector = this.lastSector < 0 ? 0 : this.lastSector;
    const offset = sector * BYTES_PER_SECTOR + this.byteInSector;
    if (offset >= this.trackData.length) return 0xff;
    const byte = this.trackData[offset] ?? 0xff;
    this.byteInSector = (this.byteInSector + 1) % BYTES_PER_SECTOR;
    return byte;
  }

  private writeData(value: number): void {
    if (!this.writeEnabled || !this.writeBuffer) return;
    const sector = this.lastSector < 0 ? 0 : this.lastSector;
    const offset = sector * BYTES_PER_SECTOR + this.byteInSector;
    if (offset < this.writeBuffer.length) {
      this.writeBuffer[offset] = value & 0xff;
      this.writeDirty = true;
    }
    this.byteInSector = (this.byteInSector + 1) % BYTES_PER_SECTOR;
  }

  // --- Private helpers ---

  private fetchTrack(): void {
    if (this.selectedDrive === 0xFF || !this.headLoaded) return;
    this.fetchPending = true;
    const drive = this.selectedDrive;
    this.fdcClient
      .readTrack(drive, this.currentTrack, TRACK_LEN)
      .then(data  => { this.trackData = data; this.cacheDrive = drive; })
      .catch(()   => { this.trackData = null; })
      .finally(() => { this.fetchPending = false; });
  }

  private flushWrite(): void {
    if (!this.writeDirty || !this.writeBuffer || this.selectedDrive === 0xFF) return;
    const data  = this.writeBuffer;
    const drive = this.selectedDrive;
    const track = this.currentTrack;
    this.writeBuffer  = null;
    this.writeDirty   = false;
    this.writeEnabled = false;
    this.fdcClient.writeTrack(drive, track, data).catch(() => {});
  }

  private issueStep(dir: 'in' | 'out'): void {
    if (this.headMoving) return;
    if (dir === 'in')  this.currentTrack = Math.min(MAX_TRACK, this.currentTrack + 1);
    else               this.currentTrack = Math.max(0, this.currentTrack - 1);
    this.headMoving   = true;
    this.trackData    = null;
    this.writeEnabled = false;
    setTimeout(() => {
      this.headMoving = false;
      if (this.headLoaded) this.fetchTrack();
    }, 15);
  }
}
