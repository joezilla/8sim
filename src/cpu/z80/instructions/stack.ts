import type { Z80Handler, IndexView } from '../types.js';

/** PUSH / POP for BC, DE, HL/IX/IY, and AF (view-parameterized). */
export function registerStack(table: Z80Handler[], view: IndexView): void {
  // PUSH rr
  table[0xc5] = (cpu) => { cpu.push16(cpu.regs.bc); return 11; };
  table[0xd5] = (cpu) => { cpu.push16(cpu.regs.de); return 11; };
  table[0xe5] = (cpu) => { cpu.push16(view.getPair(cpu.regs)); return 11; };
  table[0xf5] = (cpu) => { cpu.push16((cpu.regs.a << 8) | cpu.flags.toByte()); return 11; };

  // POP rr
  table[0xc1] = (cpu) => { cpu.regs.bc = cpu.pop16(); return 10; };
  table[0xd1] = (cpu) => { cpu.regs.de = cpu.pop16(); return 10; };
  table[0xe1] = (cpu) => { view.setPair(cpu.regs, cpu.pop16()); return 10; };
  table[0xf1] = (cpu) => {
    const v = cpu.pop16();
    cpu.regs.a = (v >> 8) & 0xff;
    cpu.flags.fromByte(v & 0xff);
    return 10;
  };
}
