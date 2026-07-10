import type { Z80Handler, Z80Core } from '../types.js';
import { adc16, sbc16, sub8, setSzyxp } from '../flagHelpers.js';
import { getRealR, setRealR } from '../regcodes.js';
import { u16 } from '../../../util/bits.js';

function read16(cpu: Z80Core, addr: number): number {
  return cpu.bus.read(addr) | (cpu.bus.read(u16(addr + 1)) << 8);
}

function write16(cpu: Z80Core, addr: number, v: number): void {
  cpu.bus.write(addr, v & 0xff);
  cpu.bus.write(u16(addr + 1), (v >> 8) & 0xff);
}

/** LD A,I / LD A,R flag behavior: PV takes the value of IFF2. */
function ldAToIR(cpu: Z80Core, v: number): void {
  const f = cpu.flags;
  cpu.regs.a = v & 0xff;
  f.s = (v & 0x80) !== 0;
  f.z = (v & 0xff) === 0;
  f.y = (v & 0x20) !== 0;
  f.x = (v & 0x08) !== 0;
  f.h = false;
  f.n = false;
  f.pv = cpu.iff2;
  // C unaffected
}

/** ED-prefixed instructions (excluding the block ops, which block.ts registers). */
export function registerEd(ed: Z80Handler[]): void {
  const pairGet: Record<number, (cpu: Z80Core) => number> = {
    0: (cpu) => cpu.regs.bc,
    1: (cpu) => cpu.regs.de,
    2: (cpu) => cpu.regs.hl,
    3: (cpu) => cpu.regs.sp,
  };
  const pairSet: Record<number, (cpu: Z80Core, v: number) => void> = {
    0: (cpu, v) => { cpu.regs.bc = v; },
    1: (cpu, v) => { cpu.regs.de = v; },
    2: (cpu, v) => { cpu.regs.hl = v; },
    3: (cpu, v) => { cpu.regs.sp = v; },
  };

  for (let p = 0; p < 4; p++) {
    // SBC HL,rr  (ED 42/52/62/72)
    ed[0x42 | (p << 4)] = (cpu) => {
      const hl = cpu.regs.hl;
      cpu.regs.wz = u16(hl + 1);
      cpu.regs.hl = sbc16(cpu.flags, hl, pairGet[p]!(cpu), cpu.flags.c ? 1 : 0);
      return 15;
    };
    // ADC HL,rr  (ED 4A/5A/6A/7A)
    ed[0x4a | (p << 4)] = (cpu) => {
      const hl = cpu.regs.hl;
      cpu.regs.wz = u16(hl + 1);
      cpu.regs.hl = adc16(cpu.flags, hl, pairGet[p]!(cpu), cpu.flags.c ? 1 : 0);
      return 15;
    };
    // LD (nn),rr  (ED 43/53/63/73)
    ed[0x43 | (p << 4)] = (cpu) => {
      const nn = cpu.fetchWord();
      write16(cpu, nn, pairGet[p]!(cpu));
      cpu.regs.wz = u16(nn + 1);
      return 20;
    };
    // LD rr,(nn)  (ED 4B/5B/6B/7B)
    ed[0x4b | (p << 4)] = (cpu) => {
      const nn = cpu.fetchWord();
      pairSet[p]!(cpu, read16(cpu, nn));
      cpu.regs.wz = u16(nn + 1);
      return 20;
    };
  }

  // NEG (ED 44) and its undocumented duplicates.
  const neg: Z80Handler = (cpu) => {
    cpu.regs.a = sub8(cpu.flags, 0, cpu.regs.a, 0);
    return 8;
  };
  for (const op of [0x44, 0x4c, 0x54, 0x5c, 0x64, 0x6c, 0x74, 0x7c]) ed[op] = neg;

  // RETN (ED 45 + dups) and RETI (ED 4D): both restore IFF1 from IFF2.
  const retn: Z80Handler = (cpu) => {
    cpu.iff1 = cpu.iff2;
    const pc = cpu.pop16();
    cpu.regs.pc = pc;
    cpu.regs.wz = pc;
    return 14;
  };
  for (const op of [0x45, 0x55, 0x5d, 0x65, 0x6d, 0x75, 0x7d]) ed[op] = retn;
  ed[0x4d] = retn; // RETI

  // IM 0/1/2 (ED 46/56/5E) + undocumented duplicates.
  const setIm = (mode: 0 | 1 | 2): Z80Handler => (cpu) => { cpu.im = mode; return 8; };
  ed[0x46] = setIm(0); ed[0x4e] = setIm(0); ed[0x66] = setIm(0); ed[0x6e] = setIm(0);
  ed[0x56] = setIm(1); ed[0x76] = setIm(1);
  ed[0x5e] = setIm(2); ed[0x7e] = setIm(2);

  // LD I,A / LD R,A / LD A,I / LD A,R
  ed[0x47] = (cpu) => { cpu.regs.i = cpu.regs.a; return 9; };
  ed[0x4f] = (cpu) => { cpu.regs.r = cpu.regs.a; return 9; };
  ed[0x57] = (cpu) => { ldAToIR(cpu, cpu.regs.i); return 9; };
  ed[0x5f] = (cpu) => { ldAToIR(cpu, cpu.regs.r); return 9; };

  // RRD (ED 67) / RLD (ED 6F)
  ed[0x67] = (cpu) => {
    const hl = cpu.regs.hl;
    const m = cpu.bus.read(hl);
    const a = cpu.regs.a;
    cpu.bus.write(hl, ((a << 4) | (m >> 4)) & 0xff);
    cpu.regs.a = (a & 0xf0) | (m & 0x0f);
    setSzyxp(cpu.flags, cpu.regs.a);
    cpu.flags.h = false;
    cpu.flags.n = false;
    cpu.regs.wz = u16(hl + 1);
    return 18;
  };
  ed[0x6f] = (cpu) => {
    const hl = cpu.regs.hl;
    const m = cpu.bus.read(hl);
    const a = cpu.regs.a;
    cpu.bus.write(hl, ((m << 4) | (a & 0x0f)) & 0xff);
    cpu.regs.a = (a & 0xf0) | ((m >> 4) & 0x0f);
    setSzyxp(cpu.flags, cpu.regs.a);
    cpu.flags.h = false;
    cpu.flags.n = false;
    cpu.regs.wz = u16(hl + 1);
    return 18;
  };

  // IN r,(C)  (ED 40/48/50/58/60/68/70/78) — 0x70 is IN (C): flags only, no store.
  for (let r = 0; r < 8; r++) {
    ed[0x40 | (r << 3)] = (cpu) => {
      const v = cpu.bus.ioRead(cpu.regs.c) & 0xff;
      if (r !== 6) setRealR(cpu.regs, r, v);
      setSzyxp(cpu.flags, v);
      cpu.flags.h = false;
      cpu.flags.n = false;
      cpu.regs.wz = u16(cpu.regs.bc + 1);
      return 12;
    };
  }

  // OUT (C),r  (ED 41/49/51/59/61/69/71/79) — 0x71 is OUT (C),0.
  for (let r = 0; r < 8; r++) {
    ed[0x41 | (r << 3)] = (cpu) => {
      const v = r === 6 ? 0 : getRealR(cpu.regs, r);
      cpu.bus.ioWrite(cpu.regs.c, v);
      cpu.regs.wz = u16(cpu.regs.bc + 1);
      return 12;
    };
  }
}
