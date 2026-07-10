import type { Z80Handler, IndexView } from '../types.js';
import { u16 } from '../../../util/bits.js';

/** EX/EXX exchange instructions. */
export function registerExchange(table: Z80Handler[], view: IndexView): void {
  // EX DE,HL — NOT index-affected (a DD/FD prefix still swaps DE and the real HL).
  table[0xeb] = (cpu) => {
    const de = cpu.regs.de;
    cpu.regs.de = cpu.regs.hl;
    cpu.regs.hl = de;
    return 4;
  };

  // EX AF,AF'
  table[0x08] = (cpu) => {
    const a = cpu.regs.a;
    const f = cpu.flags.toByte();
    cpu.regs.a = cpu.regs.a2;
    cpu.flags.fromByte(cpu.regs.f2);
    cpu.regs.a2 = a;
    cpu.regs.f2 = f;
    return 4;
  };

  // EXX
  table[0xd9] = (cpu) => { cpu.regs.exx(); return 4; };

  // EX (SP),HL / EX (SP),IX / EX (SP),IY
  table[0xe3] = (cpu) => {
    const sp = cpu.regs.sp;
    const lo = cpu.bus.read(sp);
    const hi = cpu.bus.read(u16(sp + 1));
    const val = view.getPair(cpu.regs);
    cpu.bus.write(sp, val & 0xff);
    cpu.bus.write(u16(sp + 1), (val >> 8) & 0xff);
    const swapped = (hi << 8) | lo;
    view.setPair(cpu.regs, swapped);
    cpu.regs.wz = swapped;
    return 19;
  };
}
