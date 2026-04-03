import type { Decoder } from '../Decoder.js';
import type { Registers } from '../Registers.js';
import type { Flags } from '../Flags.js';
import type { IBus } from '../../interfaces/IBus.js';
import { u8, u16, signBit, zeroFlag, parityFlag, auxCarryAdd, auxCarrySub } from '../../util/bits.js';

type Reg8 = 'b' | 'c' | 'd' | 'e' | 'h' | 'l' | 'a';
const REG_ORDER: (Reg8 | 'M')[] = ['b', 'c', 'd', 'e', 'h', 'l', 'M', 'a'];

function getReg(regs: Registers, r: Reg8 | 'M', bus: IBus): number {
  if (r === 'M') return bus.read(regs.hl);
  return regs[r];
}

function setArithFlags(flags: Flags, result: number, ac: boolean): void {
  const r8 = u8(result);
  flags.s = signBit(r8);
  flags.z = zeroFlag(r8);
  flags.ac = ac;
  flags.p = parityFlag(r8);
}

export function registerAlu(decoder: Decoder): void {
  // ADD r / ADD M (0x80..0x87)
  for (let r = 0; r < 8; r++) {
    const opcode = 0x80 | r;
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 7 : 4;
    decoder.register(opcode, (regs, flags, bus) => {
      const a = regs.a;
      const b = getReg(regs, reg, bus);
      const result = a + b;
      flags.cy = result > 0xff;
      flags.ac = auxCarryAdd(a, b);
      setArithFlags(flags, result, flags.ac);
      regs.a = u8(result);
      return cycles;
    });
  }

  // ADC r / ADC M (0x88..0x8F)
  for (let r = 0; r < 8; r++) {
    const opcode = 0x88 | r;
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 7 : 4;
    decoder.register(opcode, (regs, flags, bus) => {
      const a = regs.a;
      const b = getReg(regs, reg, bus);
      const cy = flags.cy ? 1 : 0;
      const result = a + b + cy;
      flags.cy = result > 0xff;
      flags.ac = auxCarryAdd(a, b, cy);
      setArithFlags(flags, result, flags.ac);
      regs.a = u8(result);
      return cycles;
    });
  }

  // SUB r / SUB M (0x90..0x97)
  for (let r = 0; r < 8; r++) {
    const opcode = 0x90 | r;
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 7 : 4;
    decoder.register(opcode, (regs, flags, bus) => {
      const a = regs.a;
      const b = getReg(regs, reg, bus);
      const result = a - b;
      flags.cy = result < 0;
      flags.ac = auxCarrySub(a, b);
      setArithFlags(flags, result, flags.ac);
      regs.a = u8(result);
      return cycles;
    });
  }

  // SBB r / SBB M (0x98..0x9F)
  for (let r = 0; r < 8; r++) {
    const opcode = 0x98 | r;
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 7 : 4;
    decoder.register(opcode, (regs, flags, bus) => {
      const a = regs.a;
      const b = getReg(regs, reg, bus);
      const borrow = flags.cy ? 1 : 0;
      const result = a - b - borrow;
      flags.cy = result < 0;
      flags.ac = auxCarrySub(a, b, borrow);
      setArithFlags(flags, result, flags.ac);
      regs.a = u8(result);
      return cycles;
    });
  }

  // ADI d8 (0xC6)
  decoder.register(0xc6, (regs, flags, bus) => {
    const a = regs.a;
    const b = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    const result = a + b;
    flags.cy = result > 0xff;
    flags.ac = auxCarryAdd(a, b);
    setArithFlags(flags, result, flags.ac);
    regs.a = u8(result);
    return 7;
  });

  // ACI d8 (0xCE)
  decoder.register(0xce, (regs, flags, bus) => {
    const a = regs.a;
    const b = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    const cy = flags.cy ? 1 : 0;
    const result = a + b + cy;
    flags.cy = result > 0xff;
    flags.ac = auxCarryAdd(a, b, cy);
    setArithFlags(flags, result, flags.ac);
    regs.a = u8(result);
    return 7;
  });

  // SUI d8 (0xD6)
  decoder.register(0xd6, (regs, flags, bus) => {
    const a = regs.a;
    const b = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    const result = a - b;
    flags.cy = result < 0;
    flags.ac = auxCarrySub(a, b);
    setArithFlags(flags, result, flags.ac);
    regs.a = u8(result);
    return 7;
  });

  // SBI d8 (0xDE)
  decoder.register(0xde, (regs, flags, bus) => {
    const a = regs.a;
    const b = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    const borrow = flags.cy ? 1 : 0;
    const result = a - b - borrow;
    flags.cy = result < 0;
    flags.ac = auxCarrySub(a, b, borrow);
    setArithFlags(flags, result, flags.ac);
    regs.a = u8(result);
    return 7;
  });

  // INR r (0x04, 0x0C, 0x14, 0x1C, 0x24, 0x2C, 0x34, 0x3C)
  for (let r = 0; r < 8; r++) {
    const opcode = 0x04 | (r << 3);
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 10 : 5;
    decoder.register(opcode, (regs, flags, bus) => {
      const old = getReg(regs, reg, bus);
      const result = old + 1;
      flags.ac = auxCarryAdd(old, 1);
      // CY not affected by INR
      flags.s = signBit(u8(result));
      flags.z = zeroFlag(u8(result));
      flags.p = parityFlag(u8(result));
      if (reg === 'M') { bus.write(regs.hl, u8(result)); }
      else { (regs as Registers)[reg as keyof Registers] = u8(result) as never; }
      return cycles;
    });
  }

  // DCR r (0x05, 0x0D, 0x15, 0x1D, 0x25, 0x2D, 0x35, 0x3D)
  for (let r = 0; r < 8; r++) {
    const opcode = 0x05 | (r << 3);
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 10 : 5;
    decoder.register(opcode, (regs, flags, bus) => {
      const old = getReg(regs, reg, bus);
      const result = old - 1;
      flags.ac = auxCarrySub(old, 1);
      // CY not affected by DCR
      flags.s = signBit(u8(result));
      flags.z = zeroFlag(u8(result));
      flags.p = parityFlag(u8(result));
      if (reg === 'M') { bus.write(regs.hl, u8(result)); }
      else { (regs as Registers)[reg as keyof Registers] = u8(result) as never; }
      return cycles;
    });
  }

  // INX B (0x03), INX D (0x13), INX H (0x23), INX SP (0x33)
  decoder.register(0x03, (regs, _flags, _bus) => { regs.bc = u16(regs.bc + 1); return 5; });
  decoder.register(0x13, (regs, _flags, _bus) => { regs.de = u16(regs.de + 1); return 5; });
  decoder.register(0x23, (regs, _flags, _bus) => { regs.hl = u16(regs.hl + 1); return 5; });
  decoder.register(0x33, (regs, _flags, _bus) => { regs.sp = u16(regs.sp + 1); return 5; });

  // DCX B (0x0B), DCX D (0x1B), DCX H (0x2B), DCX SP (0x3B)
  decoder.register(0x0b, (regs, _flags, _bus) => { regs.bc = u16(regs.bc - 1); return 5; });
  decoder.register(0x1b, (regs, _flags, _bus) => { regs.de = u16(regs.de - 1); return 5; });
  decoder.register(0x2b, (regs, _flags, _bus) => { regs.hl = u16(regs.hl - 1); return 5; });
  decoder.register(0x3b, (regs, _flags, _bus) => { regs.sp = u16(regs.sp - 1); return 5; });

  // DAD B (0x09), DAD D (0x19), DAD H (0x29), DAD SP (0x39)
  // Add register pair to HL; sets CY only
  function dad(regs: Registers, flags: Flags, rp: number): number {
    const result = regs.hl + rp;
    flags.cy = result > 0xffff;
    regs.hl = u16(result);
    return 10;
  }
  decoder.register(0x09, (regs, flags, _bus) => dad(regs, flags, regs.bc));
  decoder.register(0x19, (regs, flags, _bus) => dad(regs, flags, regs.de));
  decoder.register(0x29, (regs, flags, _bus) => dad(regs, flags, regs.hl));
  decoder.register(0x39, (regs, flags, _bus) => dad(regs, flags, regs.sp));

  // DAA (0x27) — Decimal Adjust Accumulator
  decoder.register(0x27, (regs, flags, _bus) => {
    let a = regs.a;
    let correction = 0;
    let setCY = false;

    if (flags.ac || (a & 0x0f) > 9) {
      correction |= 0x06;
    }
    if (flags.cy || a > 0x99) {
      correction |= 0x60;
      setCY = true;
    }
    const result = a + correction;
    flags.ac = auxCarryAdd(a, correction);
    flags.cy = setCY;
    a = u8(result);
    flags.s = signBit(a);
    flags.z = zeroFlag(a);
    flags.p = parityFlag(a);
    regs.a = a;
    return 4;
  });
}
