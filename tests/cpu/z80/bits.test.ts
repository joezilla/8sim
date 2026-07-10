import { describe, it, expect } from 'vitest';
import { makeZ80 } from './helpers.js';

describe('Z80 CB-prefixed instructions', () => {
  it('RLC r rotates and sets carry (8 T)', () => {
    const h = makeZ80([0x06, 0x80, 0xcb, 0x00]); // LD B,0x80 ; RLC B
    h.cpu.step();
    expect(h.cpu.step()).toBe(8);
    expect(h.cpu.regs.b).toBe(0x01);
    expect(h.cpu.flags.c).toBe(true);
  });

  it('SLA (HL) shifts memory (15 T)', () => {
    const h = makeZ80([0x21, 0x40, 0x00, 0xcb, 0x26]); // LD HL,0x40 ; SLA (HL)
    h.ram.write(0x0040, 0x81);
    h.cpu.step();
    expect(h.cpu.step()).toBe(15);
    expect(h.ram.read(0x0040)).toBe(0x02);
    expect(h.cpu.flags.c).toBe(true);
  });

  it('SLL (undocumented) shifts left and sets bit 0', () => {
    const h = makeZ80([0x06, 0x40, 0xcb, 0x30]); // LD B,0x40 ; SLL B
    h.cpu.step();
    h.cpu.step();
    expect(h.cpu.regs.b).toBe(0x81);
    expect(h.cpu.flags.c).toBe(false);
  });

  it('BIT b,r sets Z when the bit is clear (8 T)', () => {
    const h = makeZ80([0x06, 0xfd, 0xcb, 0x48]); // LD B,0xFD ; BIT 1,B (bit1 = 0)
    h.cpu.step();
    expect(h.cpu.step()).toBe(8);
    expect(h.cpu.flags.z).toBe(true);
    expect(h.cpu.flags.h).toBe(true);
    expect(h.cpu.flags.n).toBe(false);
  });

  it('RES and SET modify the addressed bit', () => {
    const h = makeZ80([0x3e, 0xff, 0xcb, 0x87, 0xcb, 0xc7]); // LD A,0xFF ; RES 0,A ; SET 0,A
    h.cpu.step();
    h.cpu.step();
    expect(h.cpu.regs.a).toBe(0xfe);
    h.cpu.step();
    expect(h.cpu.regs.a).toBe(0xff);
  });
});

describe('Z80 DD/FD indexed instructions', () => {
  it('LD IX,nn and ADD IX,BC', () => {
    // LD IX,0x1000 ; LD BC,0x0234 ; ADD IX,BC
    const h = makeZ80([0xdd, 0x21, 0x00, 0x10, 0x01, 0x34, 0x02, 0xdd, 0x09]);
    expect(h.cpu.step()).toBe(14); // LD IX,nn = 10 + 4 prefix
    expect(h.cpu.regs.ix).toBe(0x1000);
    h.cpu.step(); // LD BC
    expect(h.cpu.step()).toBe(15); // ADD IX,BC = 11 + 4
    expect(h.cpu.regs.ix).toBe(0x1234);
  });

  it('LD (IX+d),n writes to the displaced address (19 T)', () => {
    // LD IX,0x2000 ; LD (IX+4),0x77
    const h = makeZ80([0xdd, 0x21, 0x00, 0x20, 0xdd, 0x36, 0x04, 0x77]);
    h.cpu.step();
    expect(h.cpu.step()).toBe(19);
    expect(h.ram.read(0x2004)).toBe(0x77);
  });

  it('LD r,(IX+d) reads from a negative displacement (19 T)', () => {
    // LD IX,0x3000 ; LD A,(IX-1)
    const h = makeZ80([0xdd, 0x21, 0x00, 0x30, 0xdd, 0x7e, 0xff]);
    h.ram.write(0x2fff, 0x5a);
    h.cpu.step();
    expect(h.cpu.step()).toBe(19);
    expect(h.cpu.regs.a).toBe(0x5a);
  });

  it('undocumented LD A,IXH / INC IXL', () => {
    // LD IX,0xABCD ; LD A,IXH ; INC IXL
    const h = makeZ80([0xdd, 0x21, 0xcd, 0xab, 0xdd, 0x7c, 0xdd, 0x2c]);
    h.cpu.step();
    expect(h.cpu.step()).toBe(8); // LD A,IXH = 4 + 4
    expect(h.cpu.regs.a).toBe(0xab);
    expect(h.cpu.step()).toBe(8); // INC IXL
    expect(h.cpu.regs.ix).toBe(0xabce);
  });

  it('a DD prefix before a non-indexed opcode costs 4 extra T', () => {
    const h = makeZ80([0xdd, 0x00]); // DD NOP
    expect(h.cpu.step()).toBe(8); // 4 (NOP) + 4 (DD)
  });

  it('LD H,(IX+d) loads the REAL H, not IXH', () => {
    // LD IX,0x4000 ; LD H,(IX+2)
    const h = makeZ80([0xdd, 0x21, 0x00, 0x40, 0xdd, 0x66, 0x02]);
    h.ram.write(0x4002, 0x9c);
    h.cpu.step();
    h.cpu.step();
    expect(h.cpu.regs.h).toBe(0x9c);
    expect(h.cpu.regs.ixh).toBe(0x40); // IXH untouched
  });
});

describe('Z80 DDCB/FDCB instructions', () => {
  it('BIT b,(IX+d) tests the displaced byte (20 T)', () => {
    // LD IX,0x5000 ; BIT 7,(IX+0)
    const h = makeZ80([0xdd, 0x21, 0x00, 0x50, 0xdd, 0xcb, 0x00, 0x7e]);
    h.ram.write(0x5000, 0x80);
    h.cpu.step();
    expect(h.cpu.step()).toBe(20);
    expect(h.cpu.flags.z).toBe(false); // bit 7 is set
  });

  it('RLC (IX+d),B result-copy variant writes memory AND B (23 T)', () => {
    // LD IX,0x6000 ; RLC (IX+0),B   (opcode 0xDD 0xCB 0x00 0x00)
    const h = makeZ80([0xdd, 0x21, 0x00, 0x60, 0xdd, 0xcb, 0x00, 0x00]);
    h.ram.write(0x6000, 0x80);
    h.cpu.step();
    expect(h.cpu.step()).toBe(23);
    expect(h.ram.read(0x6000)).toBe(0x01);
    expect(h.cpu.regs.b).toBe(0x01); // undocumented copy into B
    expect(h.cpu.flags.c).toBe(true);
  });
});
