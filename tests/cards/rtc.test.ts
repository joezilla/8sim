import { describe, it, expect } from 'vitest';
import { RtcCard } from '../../src/cards/RtcCard.js';

const BASE = 0x40;

function harness(clock: () => Date) {
  const card = new RtcCard('rtc', { base: BASE }, clock);
  const devs: Array<{ basePorts: ReadonlyArray<number>; ioRead(p: number): number; ioWrite(p: number, v: number): void }> = [];
  card.attach({ attachIODevice: (d: never) => devs.push(d) } as never);
  const dev = devs[0];
  return { card, in: (off: number) => dev.ioRead(BASE + off), out: (off: number, v: number) => dev.ioWrite(BASE + off, v), ports: dev.basePorts };
}

describe('RtcCard (MM58167)', () => {
  it('reads the host time as BCD from the counter registers', () => {
    // 2026-07-12 14:37:09.250, a Sunday (getDay()=0)
    const h = harness(() => new Date(2026, 6, 12, 14, 37, 9, 250));
    expect(h.in(0x02)).toBe(0x09); // seconds
    expect(h.in(0x03)).toBe(0x37); // minutes
    expect(h.in(0x04)).toBe(0x14); // hours (BCD, 24h)
    expect(h.in(0x05)).toBe(0x01); // day of week 1–7 (Sun→1)
    expect(h.in(0x06)).toBe(0x12); // day of month
    expect(h.in(0x07)).toBe(0x07); // month 1–12
    expect(h.in(0x01)).toBe(0x25); // hundredths (250ms → 25)
  });

  it('occupies 32 consecutive ports and ignores writes to the live counters', () => {
    const h = harness(() => new Date(2026, 0, 1, 0, 0, 30));
    expect(h.ports.length).toBe(0x20);
    h.out(0x02, 0x99); // write to seconds — ignored
    expect(h.in(0x02)).toBe(0x30); // still the host's 30 seconds
  });

  it('registers 0x08+ are read/write RAM', () => {
    const h = harness(() => new Date(0));
    h.out(0x0a, 0x42);
    expect(h.in(0x0a)).toBe(0x42);
  });
});
