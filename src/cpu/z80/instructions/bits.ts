import type { Z80Handler, Z80IndexedCbHandler, Z80Core } from '../types.js';
import type { FlagsZ80 } from '../FlagsZ80.js';
import { setSzyxp } from '../flagHelpers.js';
import { getRealR, setRealR } from '../regcodes.js';

/** Apply rotate/shift `kind` (0=RLC..7=SRL) to v, set flags, return result. */
function rotShift(f: FlagsZ80, kind: number, v: number): number {
  let c = 0;
  let r = 0;
  switch (kind) {
    case 0: c = (v >> 7) & 1; r = ((v << 1) | c) & 0xff; break;               // RLC
    case 1: c = v & 1; r = ((v >> 1) | (c << 7)) & 0xff; break;               // RRC
    case 2: c = (v >> 7) & 1; r = ((v << 1) | (f.c ? 1 : 0)) & 0xff; break;   // RL
    case 3: c = v & 1; r = ((v >> 1) | (f.c ? 0x80 : 0)) & 0xff; break;       // RR
    case 4: c = (v >> 7) & 1; r = (v << 1) & 0xff; break;                     // SLA
    case 5: c = v & 1; r = ((v >> 1) | (v & 0x80)) & 0xff; break;             // SRA
    case 6: c = (v >> 7) & 1; r = ((v << 1) | 1) & 0xff; break;               // SLL (undocumented)
    case 7: c = v & 1; r = (v >> 1) & 0xff; break;                            // SRL
  }
  setSzyxp(f, r);
  f.h = false;
  f.n = false;
  f.c = c === 1;
  return r;
}

/** BIT b test. `xySource` supplies the undocumented X/Y flag bits. */
function bitTest(f: FlagsZ80, b: number, v: number, xySource: number): void {
  const bit = v & (1 << b);
  f.z = bit === 0;
  f.pv = f.z; // parity flag mirrors zero for BIT
  f.s = b === 7 && bit !== 0;
  f.h = true;
  f.n = false;
  f.y = (xySource & 0x20) !== 0;
  f.x = (xySource & 0x08) !== 0;
  // C is unaffected
}

/**
 * Registers the plain CB table and the DDCB/FDCB (indexed) bodies.
 *
 * Plain CB handlers return the FULL T-state count (the CB dispatcher does not add
 * the prefix). Indexed handlers return the count minus the DD/FD prefix (which
 * step() adds): rot/shift/res/set = 19 (→23), BIT = 16 (→20).
 */
export function registerBits(cb: Z80Handler[], idxCb: Z80IndexedCbHandler[]): void {
  // ---- Plain CB (HL/real-register) space ----
  for (let op = 0; op < 0x40; op++) {
    const kind = (op >> 3) & 7;
    const reg = op & 7;
    if (reg === 6) {
      cb[op] = (cpu) => {
        const addr = cpu.regs.hl;
        cpu.bus.write(addr, rotShift(cpu.flags, kind, cpu.bus.read(addr)));
        return 15;
      };
    } else {
      cb[op] = (cpu) => {
        setRealR(cpu.regs, reg, rotShift(cpu.flags, kind, getRealR(cpu.regs, reg)));
        return 8;
      };
    }
  }

  // BIT b,r  (0x40..0x7F)
  for (let op = 0x40; op <= 0x7f; op++) {
    const b = (op >> 3) & 7;
    const reg = op & 7;
    if (reg === 6) {
      cb[op] = (cpu) => {
        // BIT b,(HL): X/Y come from the high byte of WZ (MEMPTR).
        bitTest(cpu.flags, b, cpu.bus.read(cpu.regs.hl), cpu.regs.wz >> 8);
        return 12;
      };
    } else {
      cb[op] = (cpu) => {
        const v = getRealR(cpu.regs, reg);
        bitTest(cpu.flags, b, v, v);
        return 8;
      };
    }
  }

  // RES b,r (0x80..0xBF) and SET b,r (0xC0..0xFF)
  for (let op = 0x80; op <= 0xff; op++) {
    const b = (op >> 3) & 7;
    const reg = op & 7;
    const set = op >= 0xc0;
    const mask = 1 << b;
    if (reg === 6) {
      cb[op] = (cpu) => {
        const addr = cpu.regs.hl;
        const v = cpu.bus.read(addr);
        cpu.bus.write(addr, set ? v | mask : v & ~mask);
        return 15;
      };
    } else {
      cb[op] = (cpu) => {
        const v = getRealR(cpu.regs, reg);
        setRealR(cpu.regs, reg, set ? v | mask : v & ~mask);
        return 8;
      };
    }
  }

  // ---- DDCB / FDCB indexed space (address precomputed) ----
  // rot/shift (0x00..0x3F): operate on (addr), write back, and copy the result
  // into register op&7 unless it is 6 (undocumented result-copy variants).
  for (let op = 0; op < 0x40; op++) {
    const kind = (op >> 3) & 7;
    const reg = op & 7;
    idxCb[op] = (cpu: Z80Core, addr: number) => {
      const r = rotShift(cpu.flags, kind, cpu.bus.read(addr));
      cpu.bus.write(addr, r);
      if (reg !== 6) setRealR(cpu.regs, reg, r);
      return 19;
    };
  }

  // BIT b,(IX+d) (0x40..0x7F): X/Y from the high byte of the effective address.
  for (let op = 0x40; op <= 0x7f; op++) {
    const b = (op >> 3) & 7;
    idxCb[op] = (cpu: Z80Core, addr: number) => {
      bitTest(cpu.flags, b, cpu.bus.read(addr), addr >> 8);
      return 16;
    };
  }

  // RES/SET b,(IX+d) (0x80..0xFF): apply, write back, copy to reg op&7 unless 6.
  for (let op = 0x80; op <= 0xff; op++) {
    const b = (op >> 3) & 7;
    const reg = op & 7;
    const set = op >= 0xc0;
    const mask = 1 << b;
    idxCb[op] = (cpu: Z80Core, addr: number) => {
      const v = cpu.bus.read(addr);
      const r = set ? v | mask : v & ~mask;
      cpu.bus.write(addr, r);
      if (reg !== 6) setRealR(cpu.regs, reg, r);
      return 19;
    };
  }
}
