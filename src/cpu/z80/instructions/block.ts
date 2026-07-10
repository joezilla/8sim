import type { Z80Handler, Z80Core } from '../types.js';
import { parityEven } from '../flagHelpers.js';
import { u16 } from '../../../util/bits.js';

/**
 * Block transfer (LDI/LDD/LDIR/LDDR), search (CPI/CPD/CPIR/CPDR), and I/O
 * (INI/IND/INIR/INDR, OUTI/OUTD/OTIR/OTDR).
 *
 * Repeating variants execute one iteration per step() and rewind PC by 2 to
 * re-enter, so interrupts are accepted between iterations (hardware-accurate).
 */
export function registerBlock(ed: Z80Handler[]): void {
  // ---- LDI / LDD / LDIR / LDDR ----
  const ld = (dir: 1 | -1): void => {
    const v = (cpu: Z80Core): void => {
      const byte = cpu.bus.read(cpu.regs.hl);
      cpu.bus.write(cpu.regs.de, byte);
      cpu.regs.hl = u16(cpu.regs.hl + dir);
      cpu.regs.de = u16(cpu.regs.de + dir);
      cpu.regs.bc = u16(cpu.regs.bc - 1);
      const n = (byte + cpu.regs.a) & 0xff;
      const f = cpu.flags;
      f.h = false;
      f.n = false;
      f.pv = cpu.regs.bc !== 0;
      f.y = (n & 0x02) !== 0; // bit 1 → Y
      f.x = (n & 0x08) !== 0; // bit 3 → X
      // S, Z, C unaffected
    };
    // non-repeating (LDI 0xA0 / LDD 0xA8)
    ed[dir === 1 ? 0xa0 : 0xa8] = (cpu) => { v(cpu); return 16; };
    // repeating (LDIR 0xB0 / LDDR 0xB8)
    ed[dir === 1 ? 0xb0 : 0xb8] = (cpu) => {
      v(cpu);
      if (cpu.regs.bc !== 0) {
        cpu.regs.pc = u16(cpu.regs.pc - 2);
        cpu.regs.wz = u16(cpu.regs.pc + 1);
        return 21;
      }
      return 16;
    };
  };
  ld(1);
  ld(-1);

  // ---- CPI / CPD / CPIR / CPDR ----
  const cp = (dir: 1 | -1): void => {
    const one = (cpu: Z80Core): void => {
      const a = cpu.regs.a;
      const val = cpu.bus.read(cpu.regs.hl);
      const result = (a - val) & 0xff;
      cpu.regs.hl = u16(cpu.regs.hl + dir);
      cpu.regs.bc = u16(cpu.regs.bc - 1);
      cpu.regs.wz = u16(cpu.regs.wz + dir);
      const f = cpu.flags;
      f.n = true;
      f.h = ((a & 0xf) - (val & 0xf)) < 0;
      const n = (result - (f.h ? 1 : 0)) & 0xff;
      f.s = (result & 0x80) !== 0;
      f.z = result === 0;
      f.pv = cpu.regs.bc !== 0;
      f.y = (n & 0x02) !== 0;
      f.x = (n & 0x08) !== 0;
      // C unaffected
    };
    ed[dir === 1 ? 0xa1 : 0xa9] = (cpu) => { one(cpu); return 16; };
    ed[dir === 1 ? 0xb1 : 0xb9] = (cpu) => {
      one(cpu);
      if (cpu.regs.bc !== 0 && !cpu.flags.z) {
        cpu.regs.pc = u16(cpu.regs.pc - 2);
        cpu.regs.wz = u16(cpu.regs.pc + 1);
        return 21;
      }
      return 16;
    };
  };
  cp(1);
  cp(-1);

  // ---- INI / IND / INIR / INDR ----
  const ini = (dir: 1 | -1): void => {
    const one = (cpu: Z80Core): void => {
      const f = cpu.flags;
      cpu.regs.wz = u16(cpu.regs.bc + dir);
      const val = cpu.bus.ioRead(cpu.regs.c) & 0xff;
      cpu.bus.write(cpu.regs.hl, val);
      cpu.regs.hl = u16(cpu.regs.hl + dir);
      cpu.regs.b = (cpu.regs.b - 1) & 0xff;
      const b = cpu.regs.b;
      f.n = (val & 0x80) !== 0;
      f.s = (b & 0x80) !== 0;
      f.z = b === 0;
      f.y = (b & 0x20) !== 0;
      f.x = (b & 0x08) !== 0;
      const k = val + ((cpu.regs.c + dir) & 0xff);
      f.h = k > 0xff;
      f.c = k > 0xff;
      f.pv = parityEven((k & 7) ^ b);
    };
    ed[dir === 1 ? 0xa2 : 0xaa] = (cpu) => { one(cpu); return 16; };
    ed[dir === 1 ? 0xb2 : 0xba] = (cpu) => {
      one(cpu);
      if (cpu.regs.b !== 0) {
        cpu.regs.pc = u16(cpu.regs.pc - 2);
        return 21;
      }
      return 16;
    };
  };
  ini(1);
  ini(-1);

  // ---- OUTI / OUTD / OTIR / OTDR ----
  const outi = (dir: 1 | -1): void => {
    const one = (cpu: Z80Core): void => {
      const f = cpu.flags;
      const val = cpu.bus.read(cpu.regs.hl);
      cpu.regs.b = (cpu.regs.b - 1) & 0xff;
      const b = cpu.regs.b;
      cpu.bus.ioWrite(cpu.regs.c, val);
      cpu.regs.hl = u16(cpu.regs.hl + dir);
      cpu.regs.wz = u16(cpu.regs.bc + dir);
      f.n = (val & 0x80) !== 0;
      f.s = (b & 0x80) !== 0;
      f.z = b === 0;
      f.y = (b & 0x20) !== 0;
      f.x = (b & 0x08) !== 0;
      const k = val + (cpu.regs.l);
      f.h = k > 0xff;
      f.c = k > 0xff;
      f.pv = parityEven((k & 7) ^ b);
    };
    ed[dir === 1 ? 0xa3 : 0xab] = (cpu) => { one(cpu); return 16; };
    ed[dir === 1 ? 0xb3 : 0xbb] = (cpu) => {
      one(cpu);
      if (cpu.regs.b !== 0) {
        cpu.regs.pc = u16(cpu.regs.pc - 2);
        return 21;
      }
      return 16;
    };
  };
  outi(1);
  outi(-1);
}
