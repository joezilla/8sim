import { describe, it, expect } from 'vitest';
import { FlagsZ80 } from '../../../src/cpu/z80/FlagsZ80.js';
import { add8, sub8, setLogicFlags, parityEven } from '../../../src/cpu/z80/flagHelpers.js';

describe('FlagsZ80', () => {
  it('round-trips through toByte/fromByte in S Z Y H X PV N C order', () => {
    const f = new FlagsZ80();
    for (let b = 0; b < 256; b++) {
      f.fromByte(b);
      expect(f.toByte()).toBe(b);
    }
  });

  it('places each flag in the correct bit', () => {
    const f = new FlagsZ80();
    f.s = true; expect(f.toByte()).toBe(0x80); f.s = false;
    f.z = true; expect(f.toByte()).toBe(0x40); f.z = false;
    f.y = true; expect(f.toByte()).toBe(0x20); f.y = false;
    f.h = true; expect(f.toByte()).toBe(0x10); f.h = false;
    f.x = true; expect(f.toByte()).toBe(0x08); f.x = false;
    f.pv = true; expect(f.toByte()).toBe(0x04); f.pv = false;
    f.n = true; expect(f.toByte()).toBe(0x02); f.n = false;
    f.c = true; expect(f.toByte()).toBe(0x01);
  });
});

describe('flagHelpers', () => {
  it('add8 sets carry, half-carry and overflow', () => {
    const f = new FlagsZ80();
    // 0x0F + 0x01 = 0x10: half-carry
    let r = add8(f, 0x0f, 0x01, 0);
    expect(r).toBe(0x10);
    expect(f.h).toBe(true);
    expect(f.c).toBe(false);
    expect(f.n).toBe(false);
    // 0x7F + 0x01 = 0x80: signed overflow, sign set
    r = add8(f, 0x7f, 0x01, 0);
    expect(r).toBe(0x80);
    expect(f.pv).toBe(true);
    expect(f.s).toBe(true);
    // 0xFF + 0x01 = 0x00: carry, zero
    r = add8(f, 0xff, 0x01, 0);
    expect(r).toBe(0x00);
    expect(f.c).toBe(true);
    expect(f.z).toBe(true);
  });

  it('sub8 sets N and borrow', () => {
    const f = new FlagsZ80();
    const r = sub8(f, 0x00, 0x01, 0);
    expect(r).toBe(0xff);
    expect(f.n).toBe(true);
    expect(f.c).toBe(true);
    expect(f.h).toBe(true);
    expect(f.s).toBe(true);
  });

  it('setLogicFlags sets H for AND, clears for OR/XOR', () => {
    const f = new FlagsZ80();
    setLogicFlags(f, 0x00, true);
    expect(f.h).toBe(true);
    expect(f.z).toBe(true);
    expect(f.pv).toBe(true); // parity of 0 is even
    expect(f.c).toBe(false);
    setLogicFlags(f, 0x01, false);
    expect(f.h).toBe(false);
    expect(f.pv).toBe(false); // parity of 1 is odd
  });

  it('parityEven matches bit-count parity', () => {
    expect(parityEven(0x00)).toBe(true);
    expect(parityEven(0x01)).toBe(false);
    expect(parityEven(0x03)).toBe(true);
    expect(parityEven(0xff)).toBe(true);
  });
});
