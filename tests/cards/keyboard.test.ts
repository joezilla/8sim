import { describe, it, expect } from 'vitest';
import { KeyboardCard } from '../../src/cards/KeyboardCard.js';

const DATA = 0x01;
const STATUS = 0x00;

function make(opts = {}) {
  return new KeyboardCard('kbd', { dataPort: DATA, statusPort: STATUS, readyMask: 0x01, ...opts });
}

// Reach the internal IIODevice the way the bus does: via attach().
function busOf(card: KeyboardCard) {
  const devs: Array<{ basePorts: ReadonlyArray<number>; ioRead(p: number): number; ioWrite(p: number, v: number): void }> = [];
  card.attach({ attachIODevice: (d: never) => devs.push(d) } as never);
  const dev = devs[0];
  return {
    in: (p: number) => dev.ioRead(p),
    out: (p: number, v: number) => dev.ioWrite(p, v),
    ports: dev.basePorts,
  };
}

describe('KeyboardCard', () => {
  it('status reads not-ready until a key is pressed, then ready', () => {
    const card = make();
    const bus = busOf(card);
    expect(bus.in(STATUS)).toBe(0); // nothing queued
    card.keyboard.press(0x41); // 'A'
    expect(bus.in(STATUS)).toBe(0x01); // ready bit set
  });

  it('reading the data port takes the next key and acknowledges it', () => {
    const card = make();
    const bus = busOf(card);
    card.keyboard.press(0x41); // 'A'
    expect(bus.in(DATA)).toBe(0x41);
    expect(bus.in(STATUS)).toBe(0); // acknowledged — no longer ready
    expect(bus.in(DATA)).toBe(0); // empty queue reads 0
  });

  it('keys read back FIFO in order; type() queues a whole string', () => {
    const card = make();
    const bus = busOf(card);
    card.keyboard.type('Hi');
    expect(card.keyboard.pending).toBe(2);
    expect(bus.in(DATA)).toBe('H'.charCodeAt(0));
    expect(bus.in(DATA)).toBe('i'.charCodeAt(0));
    expect(card.keyboard.pending).toBe(0);
  });

  it('honors a custom readyMask and claims both ports', () => {
    const card = make({ readyMask: 0x80 });
    const bus = busOf(card);
    expect([...bus.ports].sort()).toEqual([STATUS, DATA]);
    card.keyboard.press(0x20);
    expect(bus.in(STATUS)).toBe(0x80);
  });

  it('is input-only: CPU writes are ignored and reset drains the queue', () => {
    const card = make();
    const bus = busOf(card);
    card.keyboard.press(0x41);
    bus.out(DATA, 0xff); // writes do nothing
    bus.out(STATUS, 0xff);
    expect(bus.in(STATUS)).toBe(0x01); // key still queued
    card.reset();
    expect(bus.in(STATUS)).toBe(0); // drained
    expect(card.keyboard.pending).toBe(0);
  });
});
