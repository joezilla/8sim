import type { Decoder } from '../Decoder.js';
import type { Registers } from '../Registers.js';
import type { IBus } from '../../interfaces/IBus.js';
import { u8, u16, toWord } from '../../util/bits.js';

type Reg8 = 'b' | 'c' | 'd' | 'e' | 'h' | 'l' | 'a';

const REG_ORDER: (Reg8 | 'M')[] = ['b', 'c', 'd', 'e', 'h', 'l', 'M', 'a'];

function getReg(regs: Registers, r: Reg8 | 'M', bus: IBus): number {
  if (r === 'M') return bus.read(regs.hl);
  return regs[r];
}

function setReg(regs: Registers, r: Reg8 | 'M', val: number, bus: IBus): void {
  if (r === 'M') { bus.write(regs.hl, u8(val)); return; }
  regs[r] = u8(val);
}

export function registerData(decoder: Decoder): void {
  // MOV r1, r2 (0x40..0x7F, except 0x76 which is HLT)
  for (let dst = 0; dst < 8; dst++) {
    for (let src = 0; src < 8; src++) {
      const opcode = 0x40 | (dst << 3) | src;
      if (opcode === 0x76) continue; // HLT
      const dstReg = REG_ORDER[dst]!;
      const srcReg = REG_ORDER[src]!;
      const cycles = (dstReg === 'M' || srcReg === 'M') ? 7 : 5;
      decoder.register(opcode, (regs, _flags, bus) => {
        const val = getReg(regs, srcReg, bus);
        setReg(regs, dstReg, val, bus);
        return cycles;
      });
    }
  }

  // MVI r, d8 (0x06, 0x0E, 0x16, 0x1E, 0x26, 0x2E, 0x36, 0x3E)
  for (let r = 0; r < 8; r++) {
    const opcode = 0x06 | (r << 3);
    const reg = REG_ORDER[r]!;
    const cycles = reg === 'M' ? 10 : 7;
    decoder.register(opcode, (regs, _flags, bus) => {
      const imm = bus.read(regs.pc);
      regs.pc = u16(regs.pc + 1);
      setReg(regs, reg, imm, bus);
      return cycles;
    });
  }

  // LXI B, d16 (0x01)
  decoder.register(0x01, (regs, _flags, bus) => {
    regs.c = bus.read(regs.pc);
    regs.b = bus.read(u16(regs.pc + 1));
    regs.pc = u16(regs.pc + 2);
    return 10;
  });

  // LXI D, d16 (0x11)
  decoder.register(0x11, (regs, _flags, bus) => {
    regs.e = bus.read(regs.pc);
    regs.d = bus.read(u16(regs.pc + 1));
    regs.pc = u16(regs.pc + 2);
    return 10;
  });

  // LXI H, d16 (0x21)
  decoder.register(0x21, (regs, _flags, bus) => {
    regs.l = bus.read(regs.pc);
    regs.h = bus.read(u16(regs.pc + 1));
    regs.pc = u16(regs.pc + 2);
    return 10;
  });

  // LXI SP, d16 (0x31)
  decoder.register(0x31, (regs, _flags, bus) => {
    const lo_ = bus.read(regs.pc);
    const hi_ = bus.read(u16(regs.pc + 1));
    regs.sp = u16(toWord(hi_, lo_));
    regs.pc = u16(regs.pc + 2);
    return 10;
  });

  // LDA addr (0x3A)
  decoder.register(0x3a, (regs, _flags, bus) => {
    const lo_ = bus.read(regs.pc);
    const hi_ = bus.read(u16(regs.pc + 1));
    regs.pc = u16(regs.pc + 2);
    regs.a = bus.read(toWord(hi_, lo_));
    return 13;
  });

  // STA addr (0x32)
  decoder.register(0x32, (regs, _flags, bus) => {
    const lo_ = bus.read(regs.pc);
    const hi_ = bus.read(u16(regs.pc + 1));
    regs.pc = u16(regs.pc + 2);
    bus.write(toWord(hi_, lo_), regs.a);
    return 13;
  });

  // LHLD addr (0x2A)
  decoder.register(0x2a, (regs, _flags, bus) => {
    const lo_ = bus.read(regs.pc);
    const hi_ = bus.read(u16(regs.pc + 1));
    regs.pc = u16(regs.pc + 2);
    const addr = toWord(hi_, lo_);
    regs.l = bus.read(addr);
    regs.h = bus.read(u16(addr + 1));
    return 16;
  });

  // SHLD addr (0x22)
  decoder.register(0x22, (regs, _flags, bus) => {
    const lo_ = bus.read(regs.pc);
    const hi_ = bus.read(u16(regs.pc + 1));
    regs.pc = u16(regs.pc + 2);
    const addr = toWord(hi_, lo_);
    bus.write(addr, regs.l);
    bus.write(u16(addr + 1), regs.h);
    return 16;
  });

  // LDAX B (0x0A)
  decoder.register(0x0a, (regs, _flags, bus) => {
    regs.a = bus.read(regs.bc);
    return 7;
  });

  // LDAX D (0x1A)
  decoder.register(0x1a, (regs, _flags, bus) => {
    regs.a = bus.read(regs.de);
    return 7;
  });

  // STAX B (0x02)
  decoder.register(0x02, (regs, _flags, bus) => {
    bus.write(regs.bc, regs.a);
    return 7;
  });

  // STAX D (0x12)
  decoder.register(0x12, (regs, _flags, bus) => {
    bus.write(regs.de, regs.a);
    return 7;
  });

  // XCHG (0xEB) — exchange HL and DE
  decoder.register(0xeb, (regs, _flags, _bus) => {
    const tmp = regs.hl;
    regs.hl = regs.de;
    regs.de = tmp;
    return 5;
  });
}
