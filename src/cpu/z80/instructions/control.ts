import type { Z80Handler, IndexView } from '../types.js';
import { setSzyxp } from '../flagHelpers.js';

/** NOP, HALT, DI, EI, DAA, CPL, SCF, CCF (view-independent, live in main table). */
export function registerControl(table: Z80Handler[], _view: IndexView): void {
  // NOP
  table[0x00] = (_cpu) => 4;

  // HALT
  table[0x76] = (cpu) => { cpu.halted = true; return 4; };

  // DI
  table[0xf3] = (cpu) => { cpu.iff1 = false; cpu.iff2 = false; cpu.pendingEI = false; return 4; };

  // EI (interrupts become enabled after the following instruction)
  table[0xfb] = (cpu) => { cpu.pendingEI = true; return 4; };

  // DAA
  table[0x27] = (cpu) => {
    const f = cpu.flags;
    const a0 = cpu.regs.a;
    let corr = 0;
    let carry = false;
    if (f.h || (a0 & 0x0f) > 9) corr |= 0x06;
    if (f.c || a0 > 0x99) { corr |= 0x60; carry = true; }
    const a = (f.n ? a0 - corr : a0 + corr) & 0xff;
    cpu.regs.a = a;
    f.c = carry;
    f.h = ((a0 ^ a) & 0x10) !== 0;
    setSzyxp(f, a);
    return 4;
  };

  // CPL (complement A)
  table[0x2f] = (cpu) => {
    const f = cpu.flags;
    cpu.regs.a = ~cpu.regs.a & 0xff;
    f.h = true;
    f.n = true;
    f.y = (cpu.regs.a & 0x20) !== 0;
    f.x = (cpu.regs.a & 0x08) !== 0;
    return 4;
  };

  // SCF (set carry)
  table[0x37] = (cpu) => {
    const f = cpu.flags;
    f.c = true;
    f.h = false;
    f.n = false;
    f.y = (cpu.regs.a & 0x20) !== 0;
    f.x = (cpu.regs.a & 0x08) !== 0;
    return 4;
  };

  // CCF (complement carry)
  table[0x3f] = (cpu) => {
    const f = cpu.flags;
    f.h = f.c;
    f.c = !f.c;
    f.n = false;
    f.y = (cpu.regs.a & 0x20) !== 0;
    f.x = (cpu.regs.a & 0x08) !== 0;
    return 4;
  };
}
