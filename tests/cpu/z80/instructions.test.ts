import { describe, it, expect } from 'vitest';
import { makeZ80 } from './helpers.js';

describe('Z80 unprefixed instructions', () => {
  it('LD r,n and LD r,r with correct cycles', () => {
    const h = makeZ80([0x3e, 0x42, 0x47]); // LD A,0x42 ; LD B,A
    expect(h.cpu.step()).toBe(7);
    expect(h.cpu.regs.a).toBe(0x42);
    expect(h.cpu.step()).toBe(4);
    expect(h.cpu.regs.b).toBe(0x42);
  });

  it('LD rr,nn loads a 16-bit immediate (little-endian)', () => {
    const h = makeZ80([0x21, 0x34, 0x12]); // LD HL,0x1234
    expect(h.cpu.step()).toBe(10);
    expect(h.cpu.regs.hl).toBe(0x1234);
  });

  it('ADD A,r computes result and flags', () => {
    const h = makeZ80([0x3e, 0x0f, 0x06, 0x01, 0x80]); // LD A,0x0F ; LD B,1 ; ADD A,B
    h.cpu.step();
    h.cpu.step();
    expect(h.cpu.step()).toBe(4);
    expect(h.cpu.regs.a).toBe(0x10);
    expect(h.cpu.flags.h).toBe(true);
    expect(h.cpu.flags.n).toBe(false);
  });

  it('LD A,(HL) reads memory with 7 T-states', () => {
    const h = makeZ80([0x21, 0x10, 0x00, 0x7e]); // LD HL,0x0010 ; LD A,(HL)
    h.ram.write(0x0010, 0x99);
    h.cpu.step();
    expect(h.cpu.step()).toBe(7);
    expect(h.cpu.regs.a).toBe(0x99);
  });

  it('INC (HL) is 11 T-states and updates memory + flags', () => {
    const h = makeZ80([0x21, 0x20, 0x00, 0x34]); // LD HL,0x0020 ; INC (HL)
    h.ram.write(0x0020, 0x7f);
    h.cpu.step();
    expect(h.cpu.step()).toBe(11);
    expect(h.ram.read(0x0020)).toBe(0x80);
    expect(h.cpu.flags.pv).toBe(true); // 0x7F -> 0x80 overflow
    expect(h.cpu.flags.s).toBe(true);
  });

  it('PUSH/POP round-trips a register pair', () => {
    // LD SP,0x8000 ; LD BC,0xBEEF ; PUSH BC ; POP HL
    const h = makeZ80([0x31, 0x00, 0x80, 0x01, 0xef, 0xbe, 0xc5, 0xe1]);
    h.cpu.step(); h.cpu.step();
    expect(h.cpu.step()).toBe(11); // PUSH
    expect(h.cpu.regs.sp).toBe(0x7ffe);
    expect(h.cpu.step()).toBe(10); // POP
    expect(h.cpu.regs.hl).toBe(0xbeef);
  });

  it('CALL then RET returns to the following instruction', () => {
    // 0000: LD SP,0x8000 ; CALL 0x0008 ; HALT
    // 0008: RET
    const h = makeZ80([0x31, 0x00, 0x80, 0xcd, 0x08, 0x00, 0x76]);
    h.ram.write(0x0008, 0xc9); // RET
    h.cpu.step(); // LD SP
    expect(h.cpu.step()).toBe(17); // CALL
    expect(h.cpu.regs.pc).toBe(0x0008);
    expect(h.cpu.step()).toBe(10); // RET
    expect(h.cpu.regs.pc).toBe(0x0006);
  });

  it('DJNZ loops B times', () => {
    // LD B,3 ; (loop) DEC A ; DJNZ loop
    const h = makeZ80([0x06, 0x03, 0x3d, 0x10, 0xfd]); // 0xfd = -3 rel to next
    h.cpu.step(); // LD B,3
    let guard = 0;
    while (h.cpu.regs.b !== 0 && guard++ < 20) {
      h.cpu.step(); // DEC A
      h.cpu.step(); // DJNZ
    }
    expect(h.cpu.regs.b).toBe(0);
    expect(h.cpu.regs.a).toBe(0xfd); // decremented 3 times from 0
  });

  it('EX DE,HL swaps the pairs', () => {
    const h = makeZ80([0x11, 0x11, 0x22, 0x21, 0x33, 0x44, 0xeb]); // LD DE,.. LD HL,.. EX DE,HL
    h.cpu.step(); h.cpu.step();
    expect(h.cpu.step()).toBe(4);
    expect(h.cpu.regs.de).toBe(0x4433);
    expect(h.cpu.regs.hl).toBe(0x2211);
  });

  it("EXX and EX AF,AF' swap the shadow banks", () => {
    const h = makeZ80([0xd9, 0x08]);
    h.cpu.regs.hl = 0x1234;
    h.cpu.regs.h2 = 0xaa; h.cpu.regs.l2 = 0xbb;
    expect(h.cpu.step()).toBe(4); // EXX
    expect(h.cpu.regs.hl).toBe(0xaabb);
    h.cpu.regs.a = 0x55; h.cpu.regs.a2 = 0x66;
    expect(h.cpu.step()).toBe(4); // EX AF,AF'
    expect(h.cpu.regs.a).toBe(0x66);
    expect(h.cpu.regs.a2).toBe(0x55);
  });
});
