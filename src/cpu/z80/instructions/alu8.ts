import type { Z80Handler, IndexView, Z80Core } from '../types.js';
import { getR, setR } from '../regcodes.js';
import { add8, sub8, cp8, setLogicFlags, inc8, dec8 } from '../flagHelpers.js';

/** Apply ALU operation `kind` (0=ADD..7=CP) of `v` onto the accumulator. */
function applyAlu(cpu: Z80Core, kind: number, v: number): void {
  const f = cpu.flags;
  const regs = cpu.regs;
  switch (kind) {
    case 0: regs.a = add8(f, regs.a, v, 0); break;                 // ADD
    case 1: regs.a = add8(f, regs.a, v, f.c ? 1 : 0); break;       // ADC
    case 2: regs.a = sub8(f, regs.a, v, 0); break;                 // SUB
    case 3: regs.a = sub8(f, regs.a, v, f.c ? 1 : 0); break;       // SBC
    case 4: regs.a = regs.a & v; setLogicFlags(f, regs.a, true); break;  // AND
    case 5: regs.a = regs.a ^ v; setLogicFlags(f, regs.a, false); break; // XOR
    case 6: regs.a = regs.a | v; setLogicFlags(f, regs.a, false); break; // OR
    case 7: cp8(f, regs.a, v); break;                             // CP
  }
}

/** 8-bit arithmetic/logic and INC/DEC r in the main table (view-parameterized). */
export function registerAlu8(table: Z80Handler[], view: IndexView): void {
  // ALU A,r / ALU A,(HL)  (0x80..0xBF)
  for (let op = 0x80; op <= 0xbf; op++) {
    const kind = (op >> 3) & 7;
    const reg = op & 7;
    if (reg === 6) {
      table[op] = (cpu) => {
        const addr = view.memAddr(cpu);
        applyAlu(cpu, kind, cpu.bus.read(addr));
        return 7 + view.memExtra;
      };
    } else {
      table[op] = (cpu) => {
        applyAlu(cpu, kind, getR(cpu.regs, view, reg));
        return 4;
      };
    }
  }

  // ALU A,n  (0xC6,0xCE,0xD6,0xDE,0xE6,0xEE,0xF6,0xFE)
  for (const op of [0xc6, 0xce, 0xd6, 0xde, 0xe6, 0xee, 0xf6, 0xfe]) {
    const kind = (op >> 3) & 7;
    table[op] = (cpu) => {
      applyAlu(cpu, kind, cpu.fetchByte());
      return 7;
    };
  }

  // INC r  (0x04|r<<3)
  for (let r = 0; r < 8; r++) {
    const op = 0x04 | (r << 3);
    if (r === 6) {
      table[op] = (cpu) => {
        const addr = view.memAddr(cpu);
        cpu.bus.write(addr, inc8(cpu.flags, cpu.bus.read(addr)));
        return 11 + view.memExtra;
      };
    } else {
      table[op] = (cpu) => {
        setR(cpu.regs, view, r, inc8(cpu.flags, getR(cpu.regs, view, r)));
        return 4;
      };
    }
  }

  // DEC r  (0x05|r<<3)
  for (let r = 0; r < 8; r++) {
    const op = 0x05 | (r << 3);
    if (r === 6) {
      table[op] = (cpu) => {
        const addr = view.memAddr(cpu);
        cpu.bus.write(addr, dec8(cpu.flags, cpu.bus.read(addr)));
        return 11 + view.memExtra;
      };
    } else {
      table[op] = (cpu) => {
        setR(cpu.regs, view, r, dec8(cpu.flags, getR(cpu.regs, view, r)));
        return 4;
      };
    }
  }
}
