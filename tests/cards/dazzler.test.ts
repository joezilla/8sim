import { describe, it, expect } from 'vitest';
import { DazzlerCard } from '../../src/cards/DazzlerCard.js';

const CTRL = 0x0e;
const FMT = 0x0f;

/** A minimal bus stand-in: RAM the card DMAs from + the IO device it attaches. */
function harness() {
  const mem = new Uint8Array(0x10000);
  let dev: { basePorts: ReadonlyArray<number>; ioRead(p: number): number; ioWrite(p: number, v: number): void; reset(): void };
  const bus = {
    read: (a: number) => mem[a & 0xffff],
    write: (a: number, v: number) => { mem[a & 0xffff] = v & 0xff; },
    attachIODevice: (d: never) => { dev = d as never; },
  };
  const card = new DazzlerCard('dz', { controlPort: CTRL, formatPort: FMT });
  card.attach(bus as never);
  return { mem, card, out: (p: number, v: number) => dev.ioWrite(p, v), in: (p: number) => dev.ioRead(p) };
}

describe('DazzlerCard', () => {
  it('exposes a bitmap display surface, off until the control D7 is set', () => {
    const h = harness();
    expect(h.card.display.descriptor).toMatchObject({ mode: 'bitmap', format: 'dazzler' });
    expect(h.card.display.frame().state.on).toBe(0);
    h.out(CTRL, 0x80); // picture on, page 0
    expect(h.card.display.frame().state.on).toBe(1);
  });

  it('DMAs the buffer from the RAM page selected by the control port', () => {
    const h = harness();
    // Page 3 → base 3 << 9 = 0x0600. Drop a marker there.
    h.mem[0x0600] = 0xa5;
    h.mem[0x0601] = 0x5a;
    h.out(CTRL, 0x80 | 0x03); // on, page 3
    const f = h.card.display.frame();
    expect(f.bytes[0]).toBe(0xa5);
    expect(f.bytes[1]).toBe(0x5a);
    expect(f.state.control & 0x7f).toBe(0x03);
  });

  it('carries the format register in frame state', () => {
    const h = harness();
    h.out(FMT, 0x30); // X4 + colour
    expect(h.card.display.frame().state.format).toBe(0x30);
  });

  it('control-port reads toggle a frame-sync bit so retrace polling advances', () => {
    const h = harness();
    const a = h.in(CTRL);
    const b = h.in(CTRL);
    expect(a).not.toBe(b); // D6 flips
    expect((a ^ b) & 0x40).toBe(0x40);
  });

  it('reset clears the picture and format', () => {
    const h = harness();
    h.out(CTRL, 0xff);
    h.out(FMT, 0xff);
    h.card.reset();
    expect(h.card.display.frame().state.on).toBe(0);
    expect(h.card.display.frame().state.format).toBe(0);
  });
});
