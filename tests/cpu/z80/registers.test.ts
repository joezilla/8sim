import { describe, it, expect } from 'vitest';
import { RegistersZ80 } from '../../../src/cpu/z80/RegistersZ80.js';

describe('RegistersZ80', () => {
  it('composes and decomposes 16-bit pairs', () => {
    const r = new RegistersZ80();
    r.bc = 0x1234;
    expect(r.b).toBe(0x12);
    expect(r.c).toBe(0x34);
    r.de = 0xabcd;
    expect(r.d).toBe(0xab);
    expect(r.e).toBe(0xcd);
    r.hl = 0x8001;
    expect(r.h).toBe(0x80);
    expect(r.l).toBe(0x01);
  });

  it('exposes IX/IY high and low bytes', () => {
    const r = new RegistersZ80();
    r.ix = 0xdead;
    expect(r.ixh).toBe(0xde);
    expect(r.ixl).toBe(0xad);
    r.ixh = 0x12;
    expect(r.ix).toBe(0x12ad);
    r.ixl = 0x34;
    expect(r.ix).toBe(0x1234);

    r.iy = 0xbeef;
    expect(r.iyh).toBe(0xbe);
    expect(r.iyl).toBe(0xef);
  });

  it('increments R with bit 7 sticky', () => {
    const r = new RegistersZ80();
    r.r = 0x7f;
    r.incR();
    expect(r.r).toBe(0x00); // wrapped low 7 bits, bit 7 stays 0
    r.r = 0xff;
    r.incR();
    expect(r.r).toBe(0x80); // bit 7 preserved
    r.r = 0x80;
    r.incR();
    expect(r.r).toBe(0x81);
  });

  it('EXX swaps BC/DE/HL with the shadow set but leaves AF', () => {
    const r = new RegistersZ80();
    r.bc = 0x1111; r.de = 0x2222; r.hl = 0x3333;
    r.b2 = 0xaa; r.c2 = 0xbb; // shadow BC = 0xaabb
    r.a = 0x99;
    r.exx();
    expect(r.bc).toBe(0xaabb);
    expect(r.b2).toBe(0x11);
    expect(r.c2).toBe(0x11);
    expect(r.a).toBe(0x99); // AF untouched
  });
});
