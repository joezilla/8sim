import type { Decoder } from '../Decoder.js';
import type { Flags } from '../Flags.js';
import { u16, toWord } from '../../util/bits.js';

function readAddr(regs: { pc: number }, bus: { read(a: number): number }): number {
  const lo = bus.read(regs.pc);
  const hi = bus.read(u16(regs.pc + 1));
  regs.pc = u16(regs.pc + 2);
  return toWord(hi, lo);
}

export function registerBranch(decoder: Decoder): void {
  // JMP addr (0xC3) — unconditional
  decoder.register(0xc3, (regs, _flags, bus) => {
    regs.pc = readAddr(regs, bus);
    return 10;
  });

  // Conditional JMPs
  const jccTable: [number, (f: Flags) => boolean][] = [
    [0xc2, f => !f.z],   // JNZ
    [0xca, f => f.z],    // JZ
    [0xd2, f => !f.cy],  // JNC
    [0xda, f => f.cy],   // JC
    [0xe2, f => !f.p],   // JPO (parity odd)
    [0xea, f => f.p],    // JPE (parity even)
    [0xf2, f => !f.s],   // JP (positive)
    [0xfa, f => f.s],    // JM (minus)
  ];

  for (const [opcode, cond] of jccTable) {
    decoder.register(opcode, (regs, flags, bus) => {
      const addr = readAddr(regs, bus);
      if (cond(flags)) regs.pc = addr;
      return 10;
    });
  }

  // CALL addr (0xCD)
  decoder.register(0xcd, (regs, _flags, bus) => {
    const addr = readAddr(regs, bus);
    regs.sp = u16(regs.sp - 1);
    bus.write(regs.sp, (regs.pc >> 8) & 0xff);
    regs.sp = u16(regs.sp - 1);
    bus.write(regs.sp, regs.pc & 0xff);
    regs.pc = addr;
    return 17;
  });

  // Conditional CALLs
  const callTable: [number, (f: Flags) => boolean][] = [
    [0xc4, f => !f.z],   // CNZ
    [0xcc, f => f.z],    // CZ
    [0xd4, f => !f.cy],  // CNC
    [0xdc, f => f.cy],   // CC
    [0xe4, f => !f.p],   // CPO
    [0xec, f => f.p],    // CPE
    [0xf4, f => !f.s],   // CP
    [0xfc, f => f.s],    // CM
  ];

  for (const [opcode, cond] of callTable) {
    decoder.register(opcode, (regs, flags, bus) => {
      const addr = readAddr(regs, bus);
      if (cond(flags)) {
        regs.sp = u16(regs.sp - 1);
        bus.write(regs.sp, (regs.pc >> 8) & 0xff);
        regs.sp = u16(regs.sp - 1);
        bus.write(regs.sp, regs.pc & 0xff);
        regs.pc = addr;
        return 17;
      }
      return 11;
    });
  }

  // RET (0xC9)
  decoder.register(0xc9, (regs, _flags, bus) => {
    const lo = bus.read(regs.sp);
    const hi = bus.read(u16(regs.sp + 1));
    regs.sp = u16(regs.sp + 2);
    regs.pc = toWord(hi, lo);
    return 10;
  });

  // Conditional RETs
  const retTable: [number, (f: Flags) => boolean][] = [
    [0xc0, f => !f.z],   // RNZ
    [0xc8, f => f.z],    // RZ
    [0xd0, f => !f.cy],  // RNC
    [0xd8, f => f.cy],   // RC
    [0xe0, f => !f.p],   // RPO
    [0xe8, f => f.p],    // RPE
    [0xf0, f => !f.s],   // RP
    [0xf8, f => f.s],    // RM
  ];

  for (const [opcode, cond] of retTable) {
    decoder.register(opcode, (regs, flags, bus) => {
      if (cond(flags)) {
        const lo = bus.read(regs.sp);
        const hi = bus.read(u16(regs.sp + 1));
        regs.sp = u16(regs.sp + 2);
        regs.pc = toWord(hi, lo);
        return 11;
      }
      return 5;
    });
  }

  // RST 0..7 (0xC7, 0xCF, 0xD7, 0xDF, 0xE7, 0xEF, 0xF7, 0xFF)
  for (let n = 0; n < 8; n++) {
    const opcode = 0xc7 | (n << 3);
    decoder.register(opcode, (regs, _flags, bus) => {
      regs.sp = u16(regs.sp - 1);
      bus.write(regs.sp, (regs.pc >> 8) & 0xff);
      regs.sp = u16(regs.sp - 1);
      bus.write(regs.sp, regs.pc & 0xff);
      regs.pc = n * 8;
      return 11;
    });
  }

  // PCHL (0xE9) — Jump to HL
  decoder.register(0xe9, (regs, _flags, _bus) => {
    regs.pc = regs.hl;
    return 5;
  });
}
