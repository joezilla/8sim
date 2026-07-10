import type { FlagsZ80 } from './FlagsZ80.js';

/**
 * Shared Z80 flag computations. Every arithmetic/logic result funnels through
 * one of these so the undocumented X (bit 3) and Y (bit 5) flags — copied from
 * the result byte — are handled uniformly.
 *
 * Conventions: `cIn` is the incoming carry (0|1) for adds and the incoming
 * borrow (0|1) for subtracts. Signed-overflow (PV) uses the classic
 * `(~(a^b) & (a^r))` for adds and `((a^b) & (a^r))` for subtracts.
 */

/** Precomputed even-parity table (true = even number of set bits). */
const PARITY: boolean[] = (() => {
  const t = new Array<boolean>(256);
  for (let v = 0; v < 256; v++) {
    let x = v;
    x ^= x >> 4;
    x ^= x >> 2;
    x ^= x >> 1;
    t[v] = (x & 1) === 0;
  }
  return t;
})();

export function parityEven(v: number): boolean {
  return PARITY[v & 0xff]!;
}

/** Set S, Z, Y, X from a result byte (PV/H/N/C left to the caller). */
export function setSzyx(f: FlagsZ80, r: number): void {
  f.s = (r & 0x80) !== 0;
  f.z = (r & 0xff) === 0;
  f.y = (r & 0x20) !== 0;
  f.x = (r & 0x08) !== 0;
}

/** Set S, Z, Y, X, PV(parity) from a result byte — the "logic/rotate" flag shape. */
export function setSzyxp(f: FlagsZ80, r: number): void {
  setSzyx(f, r);
  f.pv = PARITY[r & 0xff]!;
}

/** 8-bit ADD / ADC. Returns the truncated result. */
export function add8(f: FlagsZ80, a: number, b: number, cIn: 0 | 1): number {
  const sum = a + b + cIn;
  const r = sum & 0xff;
  setSzyx(f, r);
  f.h = ((a & 0xf) + (b & 0xf) + cIn) > 0xf;
  f.pv = (~(a ^ b) & (a ^ r) & 0x80) !== 0;
  f.n = false;
  f.c = sum > 0xff;
  return r;
}

/** 8-bit SUB / SBC. `cIn` is the incoming borrow. Returns the truncated result. */
export function sub8(f: FlagsZ80, a: number, b: number, cIn: 0 | 1): number {
  const diff = a - b - cIn;
  const r = diff & 0xff;
  setSzyx(f, r);
  f.h = ((a & 0xf) - (b & 0xf) - cIn) < 0;
  f.pv = ((a ^ b) & (a ^ r) & 0x80) !== 0;
  f.n = true;
  f.c = diff < 0;
  return r;
}

/** CP: like SUB but the result is discarded and X/Y come from the operand, not the result. */
export function cp8(f: FlagsZ80, a: number, b: number): void {
  const diff = a - b;
  const r = diff & 0xff;
  f.s = (r & 0x80) !== 0;
  f.z = r === 0;
  f.y = (b & 0x20) !== 0;
  f.x = (b & 0x08) !== 0;
  f.h = ((a & 0xf) - (b & 0xf)) < 0;
  f.pv = ((a ^ b) & (a ^ r) & 0x80) !== 0;
  f.n = true;
  f.c = diff < 0;
}

/** INC r: C is preserved, so it is not touched here. */
export function inc8(f: FlagsZ80, v: number): number {
  const r = (v + 1) & 0xff;
  setSzyx(f, r);
  f.h = (v & 0xf) === 0xf;
  f.pv = v === 0x7f;
  f.n = false;
  return r;
}

/** DEC r: C is preserved, so it is not touched here. */
export function dec8(f: FlagsZ80, v: number): number {
  const r = (v - 1) & 0xff;
  setSzyx(f, r);
  f.h = (v & 0xf) === 0;
  f.pv = v === 0x80;
  f.n = true;
  return r;
}

/** AND/OR/XOR result flags. `hVal` is true for AND (H=1), false for OR/XOR (H=0). */
export function setLogicFlags(f: FlagsZ80, r: number, hVal: boolean): void {
  setSzyxp(f, r);
  f.h = hVal;
  f.n = false;
  f.c = false;
}

/** ADD HL,rr (and ADD IX/IY,rr): affects H, N, C, X, Y only. Returns 16-bit result. */
export function add16(f: FlagsZ80, a: number, b: number): number {
  const sum = a + b;
  const r = sum & 0xffff;
  f.h = ((a & 0xfff) + (b & 0xfff)) > 0xfff;
  f.n = false;
  f.c = sum > 0xffff;
  f.y = (r & 0x2000) !== 0; // bit 13 = bit 5 of high byte
  f.x = (r & 0x0800) !== 0; // bit 11 = bit 3 of high byte
  return r;
}

/** ADC HL,rr: full flags; Z from the whole 16-bit result. */
export function adc16(f: FlagsZ80, a: number, b: number, cIn: 0 | 1): number {
  const sum = a + b + cIn;
  const r = sum & 0xffff;
  f.s = (r & 0x8000) !== 0;
  f.z = r === 0;
  f.h = ((a & 0xfff) + (b & 0xfff) + cIn) > 0xfff;
  f.pv = (~(a ^ b) & (a ^ r) & 0x8000) !== 0;
  f.n = false;
  f.c = sum > 0xffff;
  f.y = (r & 0x2000) !== 0;
  f.x = (r & 0x0800) !== 0;
  return r;
}

/** SBC HL,rr: full flags; `cIn` is incoming borrow. */
export function sbc16(f: FlagsZ80, a: number, b: number, cIn: 0 | 1): number {
  const diff = a - b - cIn;
  const r = diff & 0xffff;
  f.s = (r & 0x8000) !== 0;
  f.z = r === 0;
  f.h = ((a & 0xfff) - (b & 0xfff) - cIn) < 0;
  f.pv = ((a ^ b) & (a ^ r) & 0x8000) !== 0;
  f.n = true;
  f.c = diff < 0;
  f.y = (r & 0x2000) !== 0;
  f.x = (r & 0x0800) !== 0;
  return r;
}
