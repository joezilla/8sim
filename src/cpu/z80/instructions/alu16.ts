import type { Z80Handler, IndexView } from '../types.js';
import { add16 } from '../flagHelpers.js';
import { u16 } from '../../../util/bits.js';

/** 16-bit INC/DEC and ADD HL,rr in the main table (view-parameterized). */
export function registerAlu16(table: Z80Handler[], view: IndexView): void {
  // INC rr
  table[0x03] = (cpu) => { cpu.regs.bc = u16(cpu.regs.bc + 1); return 6; };
  table[0x13] = (cpu) => { cpu.regs.de = u16(cpu.regs.de + 1); return 6; };
  table[0x23] = (cpu) => { view.setPair(cpu.regs, u16(view.getPair(cpu.regs) + 1)); return 6; };
  table[0x33] = (cpu) => { cpu.regs.sp = u16(cpu.regs.sp + 1); return 6; };

  // DEC rr
  table[0x0b] = (cpu) => { cpu.regs.bc = u16(cpu.regs.bc - 1); return 6; };
  table[0x1b] = (cpu) => { cpu.regs.de = u16(cpu.regs.de - 1); return 6; };
  table[0x2b] = (cpu) => { view.setPair(cpu.regs, u16(view.getPair(cpu.regs) - 1)); return 6; };
  table[0x3b] = (cpu) => { cpu.regs.sp = u16(cpu.regs.sp - 1); return 6; };

  // ADD HL,rr  (ADD IX,rr / ADD IY,rr) — WZ = HL(before) + 1
  const addHl = (getOperand: (cpu: Parameters<Z80Handler>[0]) => number): Z80Handler => (cpu) => {
    const hl = view.getPair(cpu.regs);
    cpu.regs.wz = u16(hl + 1);
    view.setPair(cpu.regs, add16(cpu.flags, hl, getOperand(cpu)));
    return 11;
  };
  table[0x09] = addHl((cpu) => cpu.regs.bc);
  table[0x19] = addHl((cpu) => cpu.regs.de);
  table[0x29] = addHl((cpu) => view.getPair(cpu.regs));
  table[0x39] = addHl((cpu) => cpu.regs.sp);
}
