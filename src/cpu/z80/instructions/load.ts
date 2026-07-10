import type { Z80Handler, IndexView, Z80Core } from '../types.js';
import { getR, setR, getRealR, setRealR } from '../regcodes.js';
import { u16 } from '../../../util/bits.js';

function read16(cpu: Z80Core, addr: number): number {
  const lo = cpu.bus.read(addr);
  const hi = cpu.bus.read(u16(addr + 1));
  return (hi << 8) | lo;
}

function write16(cpu: Z80Core, addr: number, v: number): void {
  cpu.bus.write(addr, v & 0xff);
  cpu.bus.write(u16(addr + 1), (v >> 8) & 0xff);
}

/**
 * 8-bit and 16-bit LD instructions in the main table (view-parameterized).
 * The 0x76 slot of the LD block is HALT and is registered by control.ts.
 */
export function registerLoad(table: Z80Handler[], view: IndexView): void {
  // LD r,r' / LD r,(HL) / LD (HL),r  (0x40..0x7F, minus 0x76 = HALT)
  for (let op = 0x40; op <= 0x7f; op++) {
    if (op === 0x76) continue;
    const dst = (op >> 3) & 7;
    const src = op & 7;
    if (src === 6) {
      // LD dst,(HL/IX+d) — destination register is never index-substituted.
      table[op] = (cpu) => {
        const addr = view.memAddr(cpu);
        setRealR(cpu.regs, dst, cpu.bus.read(addr));
        return 7 + view.memExtra;
      };
    } else if (dst === 6) {
      // LD (HL/IX+d),src — source register is never index-substituted.
      table[op] = (cpu) => {
        const addr = view.memAddr(cpu);
        cpu.bus.write(addr, getRealR(cpu.regs, src));
        return 7 + view.memExtra;
      };
    } else {
      table[op] = (cpu) => {
        setR(cpu.regs, view, dst, getR(cpu.regs, view, src));
        return 4;
      };
    }
  }

  // LD r,n  (0x06,0x0E,0x16,0x1E,0x26,0x2E,0x36,0x3E)
  for (let r = 0; r < 8; r++) {
    const op = 0x06 | (r << 3);
    if (r === 6) {
      // LD (HL),n / LD (IX+d),n — indexed form has a special 19T timing (not +8).
      table[op] = (cpu) => {
        const addr = view.memAddr(cpu); // fetches d first for indexed
        cpu.bus.write(addr, cpu.fetchByte());
        return view.indexed ? 15 : 10;
      };
    } else {
      table[op] = (cpu) => {
        setR(cpu.regs, view, r, cpu.fetchByte());
        return 7;
      };
    }
  }

  // LD A,(BC) / LD A,(DE) / LD A,(nn)  — WZ = source address + 1
  table[0x0a] = (cpu) => { const a = cpu.regs.bc; cpu.regs.a = cpu.bus.read(a); cpu.regs.wz = u16(a + 1); return 7; };
  table[0x1a] = (cpu) => { const a = cpu.regs.de; cpu.regs.a = cpu.bus.read(a); cpu.regs.wz = u16(a + 1); return 7; };
  table[0x3a] = (cpu) => {
    const nn = cpu.fetchWord();
    cpu.regs.a = cpu.bus.read(nn);
    cpu.regs.wz = u16(nn + 1);
    return 13;
  };

  // LD (BC),A / LD (DE),A / LD (nn),A  — WZ = A in high byte, (addr+1) low byte
  table[0x02] = (cpu) => { const a = cpu.regs.bc; cpu.bus.write(a, cpu.regs.a); cpu.regs.wz = ((cpu.regs.a << 8) | ((a + 1) & 0xff)) & 0xffff; return 7; };
  table[0x12] = (cpu) => { const a = cpu.regs.de; cpu.bus.write(a, cpu.regs.a); cpu.regs.wz = ((cpu.regs.a << 8) | ((a + 1) & 0xff)) & 0xffff; return 7; };
  table[0x32] = (cpu) => {
    const nn = cpu.fetchWord();
    cpu.bus.write(nn, cpu.regs.a);
    cpu.regs.wz = ((cpu.regs.a << 8) | ((nn + 1) & 0xff)) & 0xffff;
    return 13;
  };

  // LD rr,nn
  table[0x01] = (cpu) => { cpu.regs.bc = cpu.fetchWord(); return 10; };
  table[0x11] = (cpu) => { cpu.regs.de = cpu.fetchWord(); return 10; };
  table[0x21] = (cpu) => { view.setPair(cpu.regs, cpu.fetchWord()); return 10; };
  table[0x31] = (cpu) => { cpu.regs.sp = cpu.fetchWord(); return 10; };

  // LD (nn),HL / LD HL,(nn)  (HL / IX / IY)
  table[0x22] = (cpu) => {
    const nn = cpu.fetchWord();
    write16(cpu, nn, view.getPair(cpu.regs));
    cpu.regs.wz = u16(nn + 1);
    return 16;
  };
  table[0x2a] = (cpu) => {
    const nn = cpu.fetchWord();
    view.setPair(cpu.regs, read16(cpu, nn));
    cpu.regs.wz = u16(nn + 1);
    return 16;
  };

  // LD SP,HL / LD SP,IX / LD SP,IY
  table[0xf9] = (cpu) => { cpu.regs.sp = view.getPair(cpu.regs); return 6; };
}
