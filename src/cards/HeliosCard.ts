import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { u8 } from '../util/bits.js';
import { type HeliosDisk, HeliosRangeError, HELIOS_HDRSIZE } from './helios/HeliosDisk.js';

/** Where the Helios boot sector loads (BOOTLOAD DMAs track 0 → 0x0000). */
export const HELIOS_BOOT_ADDR = 0x0000;

export interface HeliosOptions {
  /** Base I/O port; the card claims base..base+7. IMSAI/Sol standard = 0xF0. */
  readonly port?: number;
  /** Disk backends keyed by unit number as a string, e.g. `{ '0': disk }` (0–7). */
  readonly disks?: Record<string, HeliosDisk>;
}

// Port F0 status bits.
const ST_TC = 0x01; // transfer complete (1)
const ST_SREADY = 0x02; // controller ready (1)
const ST_ABORT = 0x04; // error (1)
const ST_CRCERR = 0x08; // CRC error (1)
const ST_CRCCHK = 0x10; // CRC checked (1)
const ST_DISKRDY = 0x20; // disk ready (0 = ready)
const ST_SEEKCMP = 0x40; // seek complete (0 = done)
const ST_INDEX = 0x80; // index present (0 = present)

// Port F1 transfer command bits.
const TC_RW_READ = 0x02; // 1 = read from disk, 0 = write
const TC_HEADER = 0x04; // 1 = header, 0 = data
const TC_EXECUTE = 0x08; // active-low: 0 = execute the transfer

/**
 * Processor Technology Helios II disk controller (Story 5.14).
 *
 * An intelligent, DMA-capable 8" disk system for the SOL-20 / S-100. The host
 * drives eight I/O ports (F0–F7) — status, DMA address/length, drive/seek and
 * transfer commands — and the controller DMAs whole blocks to/from host RAM.
 * Unlike the FIF's `(track, sector) → 128-byte sector` descriptor, the Helios is
 * firm-sectored: the host seeks by stepping, reads block *headers* to find
 * sectors, and transfers variable-length data blocks. Behavior is matched to the
 * documented boot contract (`bios/sol20/bootload.asm`) and Jim Battle's HELIOS.EXE
 * emulation model (high-level, no CRC/timing).
 *
 *   F0 IN  status        F1 OUT transfer command   F3/F4 OUT DMA length
 *   F5/F6 OUT DMA addr (F5 also clears latched status)   F7 OUT drive command
 *
 * Mirrors {@link ImsaiFifCard}'s IS100Card+IIODevice+DMA structure.
 */
export class HeliosCard implements IS100Card {
  readonly id: string;
  private readonly base: number;
  private readonly disks = new Map<number, HeliosDisk>();

  // per-unit head position (0–76); selected unit + rotational state
  private readonly track = new Int16Array(8);
  private selectedUnit = 0;
  private headLoaded = false;
  private seekComplete = true;
  private currentSector = 0;

  // DMA registers
  private dmaAddr = 0;
  private dmaLen = 0;

  // latched status (cleared by an F5 write)
  private tc = false;
  private abort = false;
  private crcError = false;
  private crcChecked = false;
  private transferPending = false;

  private bus?: Bus;
  private readonly dev: IIODevice;

  constructor(id = 'helios', opts: HeliosOptions = {}) {
    this.id = id;
    this.base = (opts.port ?? 0xf0) & 0xff;
    if (opts.disks) {
      for (const [key, disk] of Object.entries(opts.disks)) {
        const unit = Number(key);
        if (Number.isInteger(unit) && unit >= 0 && unit < 8) this.disks.set(unit, disk);
      }
    }
    const ports = Array.from({ length: 8 }, (_, i) => this.base + i);
    const self = this;
    this.dev = {
      id: `${id}:ctrl`,
      basePorts: ports,
      ioRead: (port) => (port === self.base ? self.readStatus() : 0xff),
      ioWrite: (port, value) => self.write(port - self.base, u8(value)),
      reset: () => self.reset(),
    };
  }

  attach(bus: Bus): void {
    this.bus = bus;
    bus.attachIODevice(this.dev);
  }

  reset(): void {
    this.track.fill(0);
    this.selectedUnit = 0;
    this.headLoaded = false;
    this.seekComplete = true;
    this.currentSector = 0;
    this.dmaAddr = 0;
    this.dmaLen = 0;
    this.tc = this.abort = this.crcError = this.crcChecked = false;
    this.transferPending = false;
  }

  setDisk(unit: number, disk: HeliosDisk): void {
    if (unit >= 0 && unit < 8) this.disks.set(unit, disk);
  }

  // --- Port F0 status (read) ---

  private readStatus(): number {
    let s = 0;
    if (this.tc) s |= ST_TC;
    if (!this.transferPending) s |= ST_SREADY; // ready when no transfer in flight
    if (this.abort) s |= ST_ABORT;
    if (this.crcError) s |= ST_CRCERR;
    if (this.crcChecked) s |= ST_CRCCHK;
    if (!this.disks.has(this.selectedUnit)) s |= ST_DISKRDY; // bit5: 0 = ready
    if (!this.seekComplete) s |= ST_SEEKCMP; // bit6: 0 = done
    if (!this.headLoaded) s |= ST_INDEX; // bit7: 0 = index present (once head is loaded)
    return s;
  }

  // --- register writes (offset 0..7 within the F0-base window) ---

  private write(reg: number, value: number): void {
    switch (reg) {
      case 1: this.transfer(value); return; // F1 transfer command
      case 3: this.dmaLen = (this.dmaLen & 0xf00) | value; return; // F3 length low
      case 4: this.dmaLen = (this.dmaLen & 0x0ff) | ((value & 0x0f) << 8); return; // F4 length high
      case 5: // F5 address low — ALSO clears latched status
        this.dmaAddr = (this.dmaAddr & 0xff00) | value;
        this.tc = this.abort = this.crcError = this.crcChecked = false;
        return;
      case 6: this.dmaAddr = (this.dmaAddr & 0x00ff) | (value << 8); return; // F6 address high
      case 7: this.driveCommand(value); return; // F7 drive command
      default: return; // F0 (status is read-only), F2 (spare)
    }
  }

  // --- Port F7 drive command ---

  private driveCommand(v: number): void {
    // unit = {~b3, ~b2, ~b7}  (from bootload.asm)
    const unit = ((~v >> 3) & 1) << 2 | ((~v >> 2) & 1) << 1 | ((~v >> 7) & 1);
    this.selectedUnit = unit;

    if ((v & 0x10) === 0) { // RESTORE (seek track 0)
      this.track[unit] = 0;
      this.seekComplete = true;
      this.currentSector = 0;
    }
    if ((v & 0x01) === 0) { // STEP; bit1: 0 = higher track, 1 = lower track
      const dir = (v & 0x02) ? -1 : 1;
      this.track[unit] = Math.max(0, Math.min(76, this.track[unit]! + dir));
      this.seekComplete = true;
      this.currentSector = 0;
    }
    if ((v & 0x20) === 0 || (v & 0x40) === 0) { // LOAD HEAD 0 / 1
      this.headLoaded = true;
      this.currentSector = 0;
    }
  }

  // --- Port F1 transfer command (DMA) ---

  private transfer(v: number): void {
    if ((v & TC_EXECUTE) !== 0) return; // bit3 high → no transfer / cancel
    const bus = this.bus;
    if (!bus) return;

    const isRead = (v & TC_RW_READ) !== 0;
    const isHeader = (v & TC_HEADER) !== 0;
    const unit = this.selectedUnit;
    const track = this.track[unit]!;
    const addr = this.dmaAddr;
    const len = this.dmaLen;
    const disk = this.disks.get(unit);

    this.tc = this.crcChecked = this.crcError = this.abort = false;
    if (!disk) { this.abort = true; this.tc = true; return; }

    this.transferPending = true;
    const done = (): void => { this.tc = true; this.crcChecked = true; this.transferPending = false; };
    const fail = (): void => { this.abort = true; this.tc = true; this.transferPending = false; };

    if (isRead && isHeader) {
      disk.readHeader(track, this.currentSector)
        .then((hdr) => { this.dmaOut(bus, addr, hdr.subarray(0, HELIOS_HDRSIZE)); this.advance(); done(); })
        .catch(fail);
    } else if (isRead) {
      disk.readData(track, this.currentSector, len)
        .then((data) => { this.dmaOut(bus, addr, data); done(); })
        .catch(fail);
    } else if (isHeader) {
      const hdr = this.dmaIn(bus, addr, HELIOS_HDRSIZE);
      disk.writeHeader(track, this.currentSector, hdr).then(done).catch(fail);
    } else {
      const data = this.dmaIn(bus, addr, len);
      disk.writeData(track, this.currentSector, data).then(done).catch(fail);
    }
  }

  private advance(): void {
    this.currentSector = (this.currentSector + 1) % 16;
  }

  /** DMA bytes from the controller to host RAM. */
  private dmaOut(bus: Bus, addr: number, data: Uint8Array): void {
    for (let i = 0; i < data.length; i++) bus.write((addr + i) & 0xffff, u8(data[i] ?? 0));
  }

  /** DMA bytes from host RAM into the controller. */
  private dmaIn(bus: Bus, addr: number, length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = bus.read((addr + i) & 0xffff) & 0xff;
    return out;
  }
}

// re-exported for callers that catch range errors from the disk layer
export { HeliosRangeError };
