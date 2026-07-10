import type { RegistersZ80 } from './RegistersZ80.js';
import type { IndexView, Z80Core } from './types.js';

/** Sign-extend an 8-bit displacement to a signed JS number. */
export function sext8(b: number): number {
  return (b & 0x80) !== 0 ? (b & 0xff) - 0x100 : b & 0xff;
}

/** HL view — the unprefixed instruction table. */
export const HL_VIEW: IndexView = {
  kind: 'hl',
  indexed: false,
  memExtra: 0,
  getPair: (r) => r.hl,
  setPair: (r, v) => { r.hl = v & 0xffff; },
  getHi: (r) => r.h,
  setHi: (r, v) => { r.h = v & 0xff; },
  getLo: (r) => r.l,
  setLo: (r, v) => { r.l = v & 0xff; },
  // Plain (HL) access does not touch WZ.
  memAddr: (cpu) => cpu.regs.hl,
};

function makeIndexView(
  kind: 'ix' | 'iy',
  getReg: (r: RegistersZ80) => number,
  setReg: (r: RegistersZ80, v: number) => void,
  getH: (r: RegistersZ80) => number,
  setH: (r: RegistersZ80, v: number) => void,
  getL: (r: RegistersZ80) => number,
  setL: (r: RegistersZ80, v: number) => void,
): IndexView {
  return {
    kind,
    indexed: true,
    memExtra: 8, // 3 T to read d + 5 T internal add
    getPair: getReg,
    setPair: setReg,
    getHi: getH,
    setHi: setH,
    getLo: getL,
    setLo: setL,
    memAddr: (cpu: Z80Core) => {
      const d = sext8(cpu.fetchByte());
      const addr = (getReg(cpu.regs) + d) & 0xffff;
      cpu.regs.wz = addr;
      return addr;
    },
  };
}

export const IX_VIEW: IndexView = makeIndexView(
  'ix',
  (r) => r.ix,
  (r, v) => { r.ix = v & 0xffff; },
  (r) => r.ixh,
  (r, v) => { r.ixh = v; },
  (r) => r.ixl,
  (r, v) => { r.ixl = v; },
);

export const IY_VIEW: IndexView = makeIndexView(
  'iy',
  (r) => r.iy,
  (r, v) => { r.iy = v & 0xffff; },
  (r) => r.iyh,
  (r, v) => { r.iyh = v; },
  (r) => r.iyl,
  (r, v) => { r.iyl = v; },
);
