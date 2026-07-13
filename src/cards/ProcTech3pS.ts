import type { IIODevice } from '../interfaces/IIODevice.js';
import type { IInterruptController } from '../interfaces/IInterruptController.js';
import { u8 } from '../util/bits.js';

/**
 * Processor Technology 3P+S I/O Module (1976) — the device core (Story 5.13).
 *
 * A multifunction S-100 board on **four consecutive I/O ports**, exposing four
 * *channels*. IN and OUT at the same port hit different logic (the 8080 IN/OUT
 * split):
 *
 *   Channel A / B  — general-purpose 8-bit parallel ports (input byte + output
 *                    latch), each with a data-available flag FA/FB.
 *   Channel C      — IN: status word; OUT: control word.
 *   Channel D      — IN: UART RX data; OUT: UART TX data.
 *
 * The board's defining trait is that almost nothing is fixed in silicon: the
 * status-word bit layout ({@link statusMap}), the channel order within the group
 * ({@link ProcTech3pSOptions.channelOrder} / a0Invert), and the UART config are
 * all jumper-defined. This model exposes those as options with faithful defaults
 * (PT-native: TBE=0x80 bit7, RDA=0x40 bit6; control/serial-low `CDAB` order).
 *
 * There is no software master reset (unlike the 8251/6850) — reset comes from
 * the machine reset line. See `skills/PROCTECH-3P+S.skill.md`.
 */

export type ChannelOrder = 'CDAB' | 'ABCD';
export type ConfigMode = 'static' | 'dynamic';
export type StatusFlag = 'TBE' | 'RDA' | 'OE' | 'FE' | 'PE' | 'FA' | 'FB' | 'XA' | 'XB';
/** Flag → the data-bit mask it is wired to in the status word (Area G). */
export type StatusMap = Partial<Record<StatusFlag, number>>;

export interface WordFormat {
  readonly dataBits: 5 | 6 | 7 | 8;
  readonly parity: 'none' | 'even' | 'odd';
  readonly stopBits: 1 | 1.5 | 2;
}

export interface ProcTech3pSInterruptOptions {
  /** PIC line to assert; on acknowledge the PIC returns RST `0xC7 | (line<<3)`. */
  readonly line: number;
  /** Which status flags raise the interrupt (edge-triggered on false→true). */
  readonly sources: ReadonlyArray<StatusFlag>;
}

export interface ProcTech3pSOptions {
  /** Group base (A2–A7), default 0x00; the card claims base..base+3. */
  readonly baseAddress?: number;
  /** Channel order within the group. Default 'CDAB' (control/serial-low, the PT
   * software convention: status/control=base+0, UART data=base+1). */
  readonly channelOrder?: ChannelOrder;
  /** Invert A0 into the board (swaps the two port pairs) for IMSAI SIO-2 order. */
  readonly a0Invert?: boolean;
  /** Status-word bit map (Area G). Default {@link PT_NATIVE_STATUS}. */
  readonly statusMap?: StatusMap;
  /** 'static' = UART format fixed by jumpers; 'dynamic' = reloaded from control
   * bits 4–7 on every control write (Area C CRL strobed). Default 'static'. */
  readonly configMode?: ConfigMode;
  /** Default UART word format (used in static mode / initial state). */
  readonly wordFormat?: WordFormat;
  /** Opt-in interrupts (Vectored Interrupt Module). Default: polled. */
  readonly interrupts?: ProcTech3pSInterruptOptions;
  /** Interrupt controller — required iff `interrupts` is set. */
  readonly pic?: IInterruptController;
}

/** Processor Technology "native" status wiring (Appendix V). */
export const PT_NATIVE_STATUS: StatusMap = { TBE: 0x80, RDA: 0x40 };
/** IMSAI-SIO-2 / 8251-emulation status wiring (Area G rewired). */
export const SIO2_STATUS: StatusMap = { TBE: 0x01, RDA: 0x02, PE: 0x08, OE: 0x10, FE: 0x20 };

const DEFAULT_FORMAT: WordFormat = { dataBits: 8, parity: 'none', stopBits: 2 };

type ByteCallback = (byte: number) => void;

export class ProcTech3pS implements IIODevice {
  readonly id: string;
  readonly basePorts: ReadonlyArray<number>;

  private readonly base: number;
  private readonly order: ChannelOrder;
  private readonly a0Invert: boolean;
  private readonly statusMap: StatusMap;
  private readonly configMode: ConfigMode;
  private readonly defaultFormat: WordFormat;
  private readonly interrupts: ProcTech3pSInterruptOptions | undefined;
  private readonly pic: IInterruptController | undefined;

  // UART (Channel D)
  private rxQueue: number[] = [];
  private oe = false; // overrun
  private fe = false; // framing
  private pe = false; // parity
  private wordFormat: WordFormat;
  private txCb: ByteCallback | undefined;

  // Channel C control
  private controlLatch = 0; // bits 0–3
  private uartConfigNibble = 0; // bits 4–7 (opaque unless dynamic decode wanted)
  private controlCb: ByteCallback | undefined;

  // Channels A / B parallel
  private outLatch: [number, number] = [0, 0];
  private inLatch: [number, number] = [0xff, 0xff]; // float high
  private inFlag: [boolean, boolean] = [false, false]; // FA / FB
  private xdr: [boolean, boolean] = [true, true]; // XA / XB, device-ready (float high)
  private outCb: [ByteCallback | undefined, ByteCallback | undefined] = [undefined, undefined];

  constructor(id: string, options: ProcTech3pSOptions = {}) {
    this.id = id;
    this.base = (options.baseAddress ?? 0x00) & 0xff;
    this.order = options.channelOrder ?? 'CDAB';
    this.a0Invert = options.a0Invert ?? false;
    this.statusMap = options.statusMap ?? PT_NATIVE_STATUS;
    this.configMode = options.configMode ?? 'static';
    this.defaultFormat = options.wordFormat ?? DEFAULT_FORMAT;
    this.wordFormat = this.defaultFormat;
    this.interrupts = options.interrupts;
    this.pic = options.pic;
    this.basePorts = [this.base, this.base + 1, this.base + 2, this.base + 3];
  }

  // --- channel dispatch ---

  /** Map a port to its channel letter via order + optional A0 inversion. */
  private channelOf(port: number): 'A' | 'B' | 'C' | 'D' {
    let offset = (port - this.base) & 0x03;
    if (this.a0Invert) offset ^= 1;
    return this.order[offset] as 'A' | 'B' | 'C' | 'D';
  }

  ioRead(port: number): number {
    switch (this.channelOf(port)) {
      case 'C':
        return this.buildStatus(); // non-destructive
      case 'D':
        return this.readData();
      case 'A':
        return this.readParallel(0);
      case 'B':
        return this.readParallel(1);
    }
  }

  ioWrite(port: number, value: number): void {
    const v = u8(value);
    switch (this.channelOf(port)) {
      case 'C':
        this.writeControl(v);
        return;
      case 'D':
        this.txCb?.(v); // instant transmit; TBE stays true
        return;
      case 'A':
        this.writeParallel(0, v);
        return;
      case 'B':
        this.writeParallel(1, v);
        return;
    }
  }

  reset(): void {
    // No software master reset register — this models the S-100 reset line.
    this.rxQueue = [];
    this.oe = this.fe = this.pe = false;
    this.wordFormat = this.defaultFormat;
    this.controlLatch = 0;
    this.uartConfigNibble = 0;
    this.outLatch = [0, 0];
    this.inLatch = [0xff, 0xff];
    this.inFlag = [false, false];
    this.xdr = [true, true];
    // txCb / controlCb / outCb survive reset — they are host wiring.
  }

  // --- Channel C: status / control ---

  private buildStatus(): number {
    let s = 0;
    const set = (flag: StatusFlag, on: boolean): void => {
      if (on) s |= this.statusMap[flag] ?? 0;
    };
    set('TBE', true); // instant emulated TX — transmit buffer always ready
    set('RDA', this.rxQueue.length > 0);
    set('OE', this.oe);
    set('FE', this.fe);
    set('PE', this.pe);
    set('FA', this.inFlag[0]);
    set('FB', this.inFlag[1]);
    set('XA', this.xdr[0]);
    set('XB', this.xdr[1]);
    return s & 0xff;
  }

  private writeControl(v: number): void {
    this.controlLatch = v & 0x0f; // bits 0–3: RTS / peripheral driver / baud select
    if (this.configMode === 'dynamic') {
      // Area C strobes CRL on every control write: bits 4–7 reload UART config.
      this.uartConfigNibble = (v >> 4) & 0x0f;
      this.wordFormat = decodeWordFormat(this.uartConfigNibble, this.defaultFormat);
    }
    this.controlCb?.(v);
  }

  // --- Channel D: UART data ---

  private readData(): number {
    const byte = this.rxQueue.shift();
    if (this.rxQueue.length === 0) {
      this.oe = false; // overrun clears once the buffer drains (DRR)
      this.fe = this.pe = false;
    }
    return byte !== undefined ? byte : 0xff;
  }

  // --- Channels A / B: parallel ---

  private readParallel(i: 0 | 1): number {
    this.inFlag[i] = false; // reading clears the data-available flag (FA/FB)
    return this.inLatch[i];
  }

  private writeParallel(i: 0 | 1, v: number): void {
    this.outLatch[i] = v;
    this.outCb[i]?.(v); // fires the output strobe to the attached device
  }

  // --- host wiring ---

  onTransmit(cb: ByteCallback): void { this.txCb = cb; }
  onControl(cb: ByteCallback): void { this.controlCb = cb; }

  /** Feed a received serial byte. Sets RDA; a byte arriving with the buffer
   * still full flags an overrun (OE), matching the AY-5-1013 single-byte RHR. */
  enqueueRx(byte: number): void {
    const wasReady = this.rxQueue.length > 0;
    if (wasReady) this.oe = true;
    this.rxQueue.push(u8(byte));
    if (!wasReady) this.raiseIfSource('RDA'); // false→true edge
  }

  /** Inject receive error flags (framing / parity) for the current byte. */
  setErrors(pe: boolean, fe: boolean): void { this.pe = pe; this.fe = fe; }

  /** Present a parallel byte from the attached device (an XDAA/XDAB pulse):
   * latches the input and raises FA/FB. The next `IN` clears the flag. */
  pulseInput(i: 0 | 1, byte: number): void {
    this.inLatch[i] = u8(byte);
    const wasSet = this.inFlag[i];
    this.inFlag[i] = true;
    if (!wasSet) this.raiseIfSource(i === 0 ? 'FA' : 'FB');
  }

  /** Drive the parallel input pins without raising FA/FB (e.g. sense switches). */
  setInput(i: 0 | 1, byte: number): void { this.inLatch[i] = u8(byte); }

  /** Set the external-device-ready line (XA/XB) for output handshaking. */
  setDeviceReady(i: 0 | 1, ready: boolean): void { this.xdr[i] = ready; }

  onOutput(i: 0 | 1, cb: ByteCallback): void { this.outCb[i] = cb; }

  /** Last latched parallel output byte for channel A (0) / B (1). */
  output(i: 0 | 1): number { return this.outLatch[i]; }

  /** Last control word low nibble (bits 0–3): RTS / peripheral driver / baud. */
  get control(): number { return this.controlLatch; }

  private raiseIfSource(flag: StatusFlag): void {
    if (this.interrupts && this.pic && this.interrupts.sources.includes(flag)) {
      this.pic.assertIRQ(this.interrupts.line);
    }
  }
}

/** Decode the dynamic-config nibble (bits 4–7) under the default Area-H mapping:
 * bit4=WLS1, bit5=WLS2, bit6=PI (parity inhibit), bit7=EPE. Installation-specific
 * in reality; used only when `configMode` is 'dynamic'. */
function decodeWordFormat(nibble: number, fallback: WordFormat): WordFormat {
  const wls1 = (nibble & 0x01) !== 0;
  const wls2 = (nibble & 0x02) !== 0;
  const pi = (nibble & 0x04) !== 0;
  const epe = (nibble & 0x08) !== 0;
  const dataBits: WordFormat['dataBits'] = wls1 && wls2 ? 8 : !wls1 && wls2 ? 7 : wls1 && !wls2 ? 6 : 5;
  const parity: WordFormat['parity'] = pi ? 'none' : epe ? 'even' : 'odd';
  return { dataBits, parity, stopBits: fallback.stopBits };
}
