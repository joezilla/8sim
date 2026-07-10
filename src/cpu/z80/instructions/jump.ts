import type { Z80Handler, IndexView } from '../types.js';
import type { FlagsZ80 } from '../FlagsZ80.js';
import { sext8 } from '../views.js';
import { u16 } from '../../../util/bits.js';

/** Evaluate condition code cc (0=NZ,1=Z,2=NC,3=C,4=PO,5=PE,6=P,7=M). */
function cond(f: FlagsZ80, cc: number): boolean {
  switch (cc) {
    case 0: return !f.z;
    case 1: return f.z;
    case 2: return !f.c;
    case 3: return f.c;
    case 4: return !f.pv;
    case 5: return f.pv;
    case 6: return !f.s;
    default: return f.s;
  }
}

/** Jump, call, return, and restart instructions (mostly view-independent). */
export function registerJump(table: Z80Handler[], view: IndexView): void {
  // JP nn
  table[0xc3] = (cpu) => { const nn = cpu.fetchWord(); cpu.regs.pc = nn; cpu.regs.wz = nn; return 10; };

  // JP cc,nn
  for (let cc = 0; cc < 8; cc++) {
    const op = 0xc2 | (cc << 3);
    table[op] = (cpu) => {
      const nn = cpu.fetchWord();
      cpu.regs.wz = nn;
      if (cond(cpu.flags, cc)) cpu.regs.pc = nn;
      return 10;
    };
  }

  // JR e
  table[0x18] = (cpu) => {
    const e = sext8(cpu.fetchByte());
    cpu.regs.pc = u16(cpu.regs.pc + e);
    cpu.regs.wz = cpu.regs.pc;
    return 12;
  };

  // JR cc,e  (cc: 0=NZ,1=Z,2=NC,3=C at 0x20/0x28/0x30/0x38)
  for (let cc = 0; cc < 4; cc++) {
    const op = 0x20 | (cc << 3);
    table[op] = (cpu) => {
      const e = sext8(cpu.fetchByte());
      if (cond(cpu.flags, cc)) {
        cpu.regs.pc = u16(cpu.regs.pc + e);
        cpu.regs.wz = cpu.regs.pc;
        return 12;
      }
      return 7;
    };
  }

  // DJNZ e
  table[0x10] = (cpu) => {
    const e = sext8(cpu.fetchByte());
    cpu.regs.b = (cpu.regs.b - 1) & 0xff;
    if (cpu.regs.b !== 0) {
      cpu.regs.pc = u16(cpu.regs.pc + e);
      cpu.regs.wz = cpu.regs.pc;
      return 13;
    }
    return 8;
  };

  // CALL nn
  table[0xcd] = (cpu) => {
    const nn = cpu.fetchWord();
    cpu.regs.wz = nn;
    cpu.push16(cpu.regs.pc);
    cpu.regs.pc = nn;
    return 17;
  };

  // CALL cc,nn
  for (let cc = 0; cc < 8; cc++) {
    const op = 0xc4 | (cc << 3);
    table[op] = (cpu) => {
      const nn = cpu.fetchWord();
      cpu.regs.wz = nn;
      if (cond(cpu.flags, cc)) {
        cpu.push16(cpu.regs.pc);
        cpu.regs.pc = nn;
        return 17;
      }
      return 10;
    };
  }

  // RET
  table[0xc9] = (cpu) => { const pc = cpu.pop16(); cpu.regs.pc = pc; cpu.regs.wz = pc; return 10; };

  // RET cc
  for (let cc = 0; cc < 8; cc++) {
    const op = 0xc0 | (cc << 3);
    table[op] = (cpu) => {
      if (cond(cpu.flags, cc)) {
        const pc = cpu.pop16();
        cpu.regs.pc = pc;
        cpu.regs.wz = pc;
        return 11;
      }
      return 5;
    };
  }

  // RST n
  for (let n = 0; n < 8; n++) {
    const op = 0xc7 | (n << 3);
    const target = n << 3;
    table[op] = (cpu) => {
      cpu.push16(cpu.regs.pc);
      cpu.regs.pc = target;
      cpu.regs.wz = target;
      return 11;
    };
  }

  // JP (HL) / JP (IX) / JP (IY)
  table[0xe9] = (cpu) => { cpu.regs.pc = view.getPair(cpu.regs); return 4; };
}
