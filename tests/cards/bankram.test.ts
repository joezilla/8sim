import { describe, it, expect } from 'vitest';
import { BankRamCard } from '../../src/cards/BankRamCard.js';

const WINDOW = 0xc000;
const SIZE = 0x100;
const SEL = 0x40;

function harness() {
  const card = new BankRamCard('bank', { window: WINDOW, size: SIZE, banks: 4, selectPort: SEL });
  let mem: { baseAddress: number; size: number; read(o: number): number; write(o: number, v: number): void };
  let dev: { basePorts: ReadonlyArray<number>; ioRead(p: number): number; ioWrite(p: number, v: number): void };
  card.attach({
    attachMemory: (m: never) => { mem = m as never; },
    attachIODevice: (d: never) => { dev = d as never; },
  } as never);
  return {
    card,
    read: (off: number) => mem.read(off),
    write: (off: number, v: number) => mem.write(off, v),
    select: (n: number) => dev.ioWrite(SEL, n),
    selected: () => dev.ioRead(SEL),
    base: mem!.baseAddress,
    size: mem!.size,
  };
}

describe('BankRamCard (bank-switching MMU)', () => {
  it('exposes the window at the configured base + size', () => {
    const h = harness();
    expect(h.base).toBe(WINDOW);
    expect(h.size).toBe(SIZE);
  });

  it('each bank keeps its own contents; the select port swaps which is visible', () => {
    const h = harness();
    h.select(0);
    h.write(0x10, 0xaa);
    h.select(1);
    h.write(0x10, 0xbb); // same offset, different bank
    expect(h.read(0x10)).toBe(0xbb);
    h.select(0);
    expect(h.read(0x10)).toBe(0xaa); // bank 0 untouched
    expect(h.selected()).toBe(0);
  });

  it('the bank select wraps modulo the bank count', () => {
    const h = harness(); // 4 banks
    h.select(1);
    h.write(0x00, 0x11);
    h.select(5); // 5 % 4 == 1
    expect(h.read(0x00)).toBe(0x11);
    expect(h.selected()).toBe(1);
  });

  it('reset clears every bank and returns to bank 0', () => {
    const h = harness();
    h.select(2);
    h.write(0x00, 0x77);
    h.card.reset();
    expect(h.selected()).toBe(0);
    h.select(2);
    expect(h.read(0x00)).toBe(0);
  });
});
