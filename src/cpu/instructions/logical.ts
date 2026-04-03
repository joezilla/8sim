import type { Decoder } from '../Decoder.js';
import type { Registers } from '../Registers.js';
import type { Flags } from '../Flags.js';
import type { IBus } from '../../interfaces/IBus.js';
import { u8, u16, signBit, zeroFlag, parityFlag } from '../../util/bits.js';

type Reg8 = 'b' | 'c' | 'd' | 'e' | 'h' | 'l' | 'a';
const REG_ORDER: (Reg8 | 'M')[] = ['b', 'c', 'd', 'e', 'h', 'l', 'M', 'a'];

function getReg(regs: Registers, r: Reg8 | 'M', bus: IBus): number {
  if (r === 'M') return bus.read(regs.hl);
  return regs[r];
}

function setLogicFlags(flags: Flags, result: number): void {
  const r8 = u8(result);
  flags.s = signBit(r8);
  flags.z = zeroFlag(r8);
  flags.p = parityFlag(r8);
  flags.cy = false;
}

export function registerLogical(decoder: Decoder): void {
  // ANA r / ANA M (0xA0..0xA7)
  for (let r = 0; r < 8; r++) {
    const opcode = 0xa0 | r;
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 7 : 4;
    decoder.register(opcode, (regs, flags, bus) => {
      const result = regs.a & getReg(regs, reg, bus);
      flags.ac = ((regs.a | getReg(regs, reg, bus)) & 0x08) !== 0;
      setLogicFlags(flags, result);
      regs.a = u8(result);
      return cycles;
    });
  }

  // ANI d8 (0xE6)
  decoder.register(0xe6, (regs, flags, bus) => {
    const imm = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    flags.ac = ((regs.a | imm) & 0x08) !== 0;
    const result = regs.a & imm;
    setLogicFlags(flags, result);
    regs.a = u8(result);
    return 7;
  });

  // ORA r / ORA M (0xB0..0xB7)
  for (let r = 0; r < 8; r++) {
    const opcode = 0xb0 | r;
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 7 : 4;
    decoder.register(opcode, (regs, flags, bus) => {
      const result = regs.a | getReg(regs, reg, bus);
      flags.ac = false;
      setLogicFlags(flags, result);
      regs.a = u8(result);
      return cycles;
    });
  }

  // ORI d8 (0xF6)
  decoder.register(0xf6, (regs, flags, bus) => {
    const imm = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    flags.ac = false;
    const result = regs.a | imm;
    setLogicFlags(flags, result);
    regs.a = u8(result);
    return 7;
  });

  // XRA r / XRA M (0xA8..0xAF)
  for (let r = 0; r < 8; r++) {
    const opcode = 0xa8 | r;
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 7 : 4;
    decoder.register(opcode, (regs, flags, bus) => {
      const result = regs.a ^ getReg(regs, reg, bus);
      flags.ac = false;
      setLogicFlags(flags, result);
      regs.a = u8(result);
      return cycles;
    });
  }

  // XRI d8 (0xEE)
  decoder.register(0xee, (regs, flags, bus) => {
    const imm = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    flags.ac = false;
    const result = regs.a ^ imm;
    setLogicFlags(flags, result);
    regs.a = u8(result);
    return 7;
  });

  // CMP r / CMP M (0xB8..0xBF)
  for (let r = 0; r < 8; r++) {
    const opcode = 0xb8 | r;
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 7 : 4;
    decoder.register(opcode, (regs, flags, bus) => {
      const a = regs.a;
      const b = getReg(regs, reg, bus);
      const result = a - b;
      flags.cy = result < 0;
      flags.ac = ((a & 0xf) - (b & 0xf)) < 0;
      setLogicFlags(flags, result);
      flags.cy = a < b;
      return cycles;
    });
  }

  // CPI d8 (0xFE)
  decoder.register(0xfe, (regs, flags, bus) => {
    const a = regs.a;
    const b = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    const result = a - b;
    flags.cy = a < b;
    flags.ac = ((a & 0xf) - (b & 0xf)) < 0;
    setLogicFlags(flags, result);
    flags.cy = a < b;
    return 7;
  });

  // CMA (0x2F) — Complement A
  decoder.register(0x2f, (regs, _flags, _bus) => {
    regs.a = u8(~regs.a);
    return 4;
  });

  // CMC (0x3F) — Complement Carry
  decoder.register(0x3f, (_regs, flags, _bus) => {
    flags.cy = !flags.cy;
    return 4;
  });

  // STC (0x37) — Set Carry
  decoder.register(0x37, (_regs, flags, _bus) => {
    flags.cy = true;
    return 4;
  });
}
