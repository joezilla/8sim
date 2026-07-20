import { describe, it, expect } from 'vitest';
import { BootRomCard, type BootRomCardOptions } from '../../src/cards/BootRomCard.js';

const WINDOW = 0xc000;
const SIZE = 0x100;
const CTRL = 0x40;

function harness(opts: Partial<BootRomCardOptions> = {}) {
  // A short image (0x20 bytes) like a real burn — bytes past it read as 0xFF.
  const image = new Uint8Array(0x20);
  image[0x00] = 0xc3; // JMP — a plausible boot vector byte
  image[0x10] = 0xa5;
  const card = new BootRomCard('boot', { window: WINDOW, size: SIZE, controlPort: CTRL, image, ...opts });
  let mem: { baseAddress: number; size: number; read(o: number): number; write(o: number, v: number): void };
  let dev: { basePorts: ReadonlyArray<number>; ioRead(p: number): number; ioWrite(p: number, v: number): void };
  card.attach({
    attachMemory: (m: never) => { mem = m as never; },
    attachIODevice: (d: never) => { dev = d as never; },
  } as never);
  return {
    card,
    image,
    read: (off: number) => mem.read(off),
    write: (off: number, v: number) => mem.write(off, v),
    pageOut: (v = 0) => dev.ioWrite(CTRL, v),
    status: () => dev.ioRead(CTRL),
    base: mem!.baseAddress,
    size: mem!.size,
  };
}

describe('BootRomCard (boot / phantom ROM overlay)', () => {
  it('exposes the window at the configured base + size', () => {
    const h = harness();
    expect(h.base).toBe(WINDOW);
    expect(h.size).toBe(SIZE);
  });

  it('reads the ROM image while the overlay is mapped in at reset', () => {
    const h = harness();
    expect(h.read(0x00)).toBe(0xc3);
    expect(h.read(0x10)).toBe(0xa5);
    expect(h.status() & 0x01).toBe(0x01); // overlay active
  });

  it('unprogrammed bytes read as 0xFF', () => {
    const h = harness();
    expect(h.read(0x20)).toBe(0xff);
  });

  it('a control-port write pages the ROM out to reveal RAM', () => {
    const h = harness();
    expect(h.read(0x10)).toBe(0xa5); // ROM
    h.pageOut();
    expect(h.read(0x10)).toBe(0x00); // shadow RAM (zeroed), ROM gone
    expect(h.status() & 0x01).toBe(0x00);
  });

  it('write-through (default): bytes written under the ROM survive the page-out', () => {
    const h = harness();
    h.write(0x10, 0x42); // ROM still reads through here...
    expect(h.read(0x10)).toBe(0xa5); // ...reads still hit ROM while mapped
    h.pageOut();
    expect(h.read(0x10)).toBe(0x42); // the write landed in shadow RAM
  });

  it('drop mode: writes are lost while the overlay is active', () => {
    const h = harness({ writeThrough: false });
    h.write(0x10, 0x42);
    h.pageOut();
    expect(h.read(0x10)).toBe(0x00); // dropped, not shadowed
  });

  it('disableValue gates which control-port write pages the ROM out', () => {
    const h = harness({ disableValue: 0x80 });
    h.pageOut(0x01); // wrong value — overlay stays mapped
    expect(h.read(0x10)).toBe(0xa5);
    h.pageOut(0x80); // matching value — pages out
    expect(h.read(0x10)).toBe(0x00);
  });

  it('reset re-maps the overlay and clears the shadow RAM', () => {
    const h = harness();
    h.write(0x10, 0x42);
    h.pageOut();
    h.card.reset();
    expect(h.status() & 0x01).toBe(0x01);
    expect(h.read(0x10)).toBe(0xa5); // ROM back
    h.pageOut();
    expect(h.read(0x10)).toBe(0x00); // shadow cleared by reset
  });

  it('an image larger than the window is truncated to size', () => {
    const big = new Uint8Array(SIZE * 2).fill(0x7e);
    const h = harness({ image: big });
    expect(h.read(0x00)).toBe(0x7e);
    expect(h.read(SIZE - 1)).toBe(0x7e);
  });
});
