import { describe, it, expect } from 'vitest';
import { makeZ80 } from './helpers.js';

describe('Z80 interrupts', () => {
  it('IM 1 pushes PC and vectors to 0x0038 (13 T)', () => {
    const h = makeZ80([0x00]); // NOP (not executed — interrupt taken first)
    h.cpu.im = 1;
    h.cpu.iff1 = true;
    h.cpu.regs.sp = 0x8000;
    h.pic.assertIRQ(0);
    const cycles = h.cpu.step();
    expect(cycles).toBe(13);
    expect(h.cpu.regs.pc).toBe(0x0038);
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(false);
    // return address (0x0000) was pushed
    expect(h.ram.read(0x7ffe)).toBe(0x00);
    expect(h.ram.read(0x7fff)).toBe(0x00);
  });

  it('EI enables interrupts only after the following instruction', () => {
    const h = makeZ80([0xfb, 0x00]); // EI ; NOP
    h.cpu.im = 1;
    h.cpu.regs.sp = 0x8000;
    h.pic.assertIRQ(0);

    expect(h.cpu.step()).toBe(4); // EI
    expect(h.cpu.regs.pc).toBe(0x0001);

    h.cpu.step(); // NOP runs — interrupt still deferred
    expect(h.cpu.regs.pc).toBe(0x0002);

    h.cpu.step(); // now the interrupt is serviced
    expect(h.cpu.regs.pc).toBe(0x0038);
  });

  it('DI clears IFF1/IFF2 and a pending EI', () => {
    const h = makeZ80([0xfb, 0xf3, 0x00]); // EI ; DI ; NOP
    h.cpu.im = 1;
    h.pic.assertIRQ(0);
    h.cpu.step(); // EI
    h.cpu.step(); // DI cancels the pending enable
    h.cpu.step(); // NOP
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.regs.pc).toBe(0x0003); // no interrupt taken
  });

  it('NMI vectors to 0x0066 regardless of IFF1 (11 T)', () => {
    const h = makeZ80([0x00]);
    h.cpu.iff1 = false;
    h.cpu.iff2 = true;
    h.cpu.regs.sp = 0x8000;
    h.cpu.triggerNMI();
    expect(h.cpu.step()).toBe(11);
    expect(h.cpu.regs.pc).toBe(0x0066);
    expect(h.cpu.iff1).toBe(false);
    expect(h.cpu.iff2).toBe(true); // preserved for RETN
  });

  it('RETN restores IFF1 from IFF2', () => {
    const h = makeZ80([0xed, 0x45]); // RETN
    h.cpu.iff1 = false;
    h.cpu.iff2 = true;
    h.cpu.regs.sp = 0x8000;
    h.ram.write(0x8000, 0x00);
    h.ram.write(0x8001, 0x40);
    expect(h.cpu.step()).toBe(14);
    expect(h.cpu.regs.pc).toBe(0x4000);
    expect(h.cpu.iff1).toBe(true);
  });

  it('IM 0 executes the acknowledge byte as a RST', () => {
    const h = makeZ80([0x00]);
    h.cpu.im = 0;
    h.cpu.iff1 = true;
    h.cpu.regs.sp = 0x8000;
    h.pic.assertIRQ(7); // ack = 0xC7|(7<<3) = 0xFF = RST 38h
    h.cpu.step();
    expect(h.cpu.regs.pc).toBe(0x0038);
  });

  it('IM 2 reads the vector from (I<<8 | ackByte) (19 T)', () => {
    const h = makeZ80([0x00]);
    h.cpu.im = 2;
    h.cpu.iff1 = true;
    h.cpu.regs.i = 0x80;
    h.cpu.regs.sp = 0x8000;
    h.pic.assertIRQ(1); // ack = 0xCF → vector table entry at 0x80CF
    h.ram.write(0x80cf, 0x21);
    h.ram.write(0x80d0, 0x43);
    expect(h.cpu.step()).toBe(19);
    expect(h.cpu.regs.pc).toBe(0x4321);
  });

  it('LD A,I copies IFF2 into the parity/overflow flag', () => {
    const h = makeZ80([0xed, 0x57]); // LD A,I
    h.cpu.iff2 = true;
    h.cpu.regs.i = 0x00;
    h.cpu.step();
    expect(h.cpu.regs.a).toBe(0x00);
    expect(h.cpu.flags.z).toBe(true);
    expect(h.cpu.flags.pv).toBe(true);
    expect(h.cpu.flags.h).toBe(false);
    expect(h.cpu.flags.n).toBe(false);
  });

  it('HALT then interrupt resumes after the HALT', () => {
    const h = makeZ80([0x76, 0x00]); // HALT ; NOP
    h.cpu.im = 1;
    h.cpu.iff1 = true;
    h.cpu.regs.sp = 0x8000;
    h.cpu.step(); // HALT
    expect(h.cpu.halted).toBe(true);
    h.cpu.step(); // halted NOP (no interrupt yet)
    h.pic.assertIRQ(0);
    h.cpu.step(); // interrupt wakes HALT
    expect(h.cpu.halted).toBe(false);
    expect(h.cpu.regs.pc).toBe(0x0038);
    // pushed return address points at the instruction after HALT
    expect(h.ram.read(0x7ffe)).toBe(0x01);
  });

  it('increments R on each fetch with bit 7 preserved', () => {
    const h = makeZ80([0x00, 0x00, 0x00]); // 3 NOPs
    h.cpu.regs.r = 0x7e;
    h.cpu.step();
    expect(h.cpu.regs.r).toBe(0x7f);
    h.cpu.step();
    expect(h.cpu.regs.r).toBe(0x00); // low 7 bits wrapped
    h.cpu.step();
    expect(h.cpu.regs.r).toBe(0x01);
  });

  it('increments R twice for a CB-prefixed instruction', () => {
    const h = makeZ80([0xcb, 0x00]); // RLC B
    h.cpu.regs.r = 0x00;
    h.cpu.step();
    expect(h.cpu.regs.r).toBe(0x02);
  });
});
