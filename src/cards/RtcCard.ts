import type { IS100Card } from '../interfaces/IS100Card.js';
import type { IIODevice } from '../interfaces/IIODevice.js';
import type { Bus } from '../bus/Bus.js';
import { u8 } from '../util/bits.js';

/** Host time source injected via CardContext.services.clock. */
export type RtcClock = () => Date;

/** Deterministic default when no host clock is wired (tests, headless builds). */
const EPOCH_ZERO: RtcClock = () => new Date(0);

const bcd = (n: number): number => (((Math.floor(n / 10) % 10) << 4) | (n % 10)) & 0xff;

export interface RtcCardOptions {
  /** Base I/O port; the chip occupies base..base+0x1F (32 registers). */
  readonly base?: number;
}

/**
 * National MM58167 real-time clock (Story 5.10). A 32-register clock/calendar
 * chip on an I/O window: the counter registers (0x00–0x07) read the host wall
 * clock as BCD, the rest (RAM / compare / interrupt / status) are plain storage.
 *
 * The host time comes from `ctx.services.clock` (a `() => Date`), so the machine
 * reads real time while tests stay deterministic by injecting a fixed clock.
 * Writes to the live counters are ignored — you can't set the host's clock.
 */
export class RtcCard implements IS100Card {
  readonly id: string;
  private readonly base: number;
  private readonly now: RtcClock;
  private readonly ram = new Uint8Array(0x20); // 0x08..0x1F are read/write storage
  private readonly dev: IIODevice;

  constructor(id = 'rtc', opts: RtcCardOptions = {}, clock: RtcClock = EPOCH_ZERO) {
    this.id = id;
    this.base = (opts.base ?? 0x40) & 0xff;
    this.now = clock;
    const self = this;
    const ports: number[] = [];
    for (let i = 0; i < 0x20; i++) ports.push((this.base + i) & 0xff);
    this.dev = {
      id: `${id}:io`,
      basePorts: ports,
      ioRead: (port: number) => self.readReg((port - self.base) & 0x1f),
      ioWrite: (port: number, value: number) => self.writeReg((port - self.base) & 0x1f, value),
      reset: () => self.ram.fill(0),
    };
  }

  attach(bus: Bus): void {
    bus.attachIODevice(this.dev);
  }

  reset(): void {
    this.ram.fill(0);
  }

  private readReg(off: number): number {
    const d = this.now();
    switch (off) {
      case 0x00: return 0; //                     thousandths of a second
      case 0x01: return bcd(Math.floor(d.getMilliseconds() / 10)); // hundredths
      case 0x02: return bcd(d.getSeconds());
      case 0x03: return bcd(d.getMinutes());
      case 0x04: return bcd(d.getHours());
      case 0x05: return bcd(d.getDay() + 1); //   day of week, 1–7
      case 0x06: return bcd(d.getDate()); //      day of month
      case 0x07: return bcd(d.getMonth() + 1); // month, 1–12
      default: return this.ram[off] ?? 0; //      RAM / compare / status registers
    }
  }

  private writeReg(off: number, value: number): void {
    if (off > 0x07) this.ram[off] = u8(value); // live counters are read-only
  }
}
