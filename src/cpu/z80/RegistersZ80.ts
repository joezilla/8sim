/**
 * Zilog Z80 register file.
 *
 * Main 8-bit registers A,B,C,D,E,H,L plus the flags register F (held separately
 * in {@link FlagsZ80}). The shadow set (A',F',B',C',D',E',H',L') is stored as raw
 * bytes here — F' as a byte since it is only ever bulk-swapped by EX AF,AF'.
 * Index registers IX/IY are 16-bit with byte accessors for the undocumented
 * IXH/IXL/IYH/IYL operations. I is the interrupt vector base; R the refresh
 * counter (bit 7 sticky). WZ is the internal MEMPTR register, observable only
 * through the X/Y flags of `BIT n,(HL)` and a few other quirks.
 */
export class RegistersZ80 {
  a = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;

  // Shadow set (swapped by EXX / EX AF,AF'). F' is a raw PSW byte.
  a2 = 0;
  f2 = 0;
  b2 = 0;
  c2 = 0;
  d2 = 0;
  e2 = 0;
  h2 = 0;
  l2 = 0;

  ix = 0;
  iy = 0;
  sp = 0;
  pc = 0;

  i = 0; // interrupt vector base
  r = 0; // refresh counter (bit 7 preserved across increments)
  wz = 0; // MEMPTR — internal 16-bit temp

  /** BC register pair */
  get bc(): number { return (this.b << 8) | this.c; }
  set bc(v: number) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }

  /** DE register pair */
  get de(): number { return (this.d << 8) | this.e; }
  set de(v: number) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }

  /** HL register pair */
  get hl(): number { return (this.h << 8) | this.l; }
  set hl(v: number) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }

  /** IX high/low bytes (undocumented IXH/IXL) */
  get ixh(): number { return (this.ix >> 8) & 0xff; }
  set ixh(v: number) { this.ix = ((v & 0xff) << 8) | (this.ix & 0xff); }
  get ixl(): number { return this.ix & 0xff; }
  set ixl(v: number) { this.ix = (this.ix & 0xff00) | (v & 0xff); }

  /** IY high/low bytes (undocumented IYH/IYL) */
  get iyh(): number { return (this.iy >> 8) & 0xff; }
  set iyh(v: number) { this.iy = ((v & 0xff) << 8) | (this.iy & 0xff); }
  get iyl(): number { return this.iy & 0xff; }
  set iyl(v: number) { this.iy = (this.iy & 0xff00) | (v & 0xff); }

  /** M1 refresh tick: low 7 bits increment, bit 7 preserved. */
  incR(): void {
    this.r = (this.r & 0x80) | ((this.r + 1) & 0x7f);
  }

  /** EXX: swap BC/DE/HL with their shadows (AF is separate, via EX AF,AF'). */
  exx(): void {
    let t = this.b; this.b = this.b2; this.b2 = t;
    t = this.c; this.c = this.c2; this.c2 = t;
    t = this.d; this.d = this.d2; this.d2 = t;
    t = this.e; this.e = this.e2; this.e2 = t;
    t = this.h; this.h = this.h2; this.h2 = t;
    t = this.l; this.l = this.l2; this.l2 = t;
  }

  reset(): void {
    this.a = this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.a2 = this.f2 = this.b2 = this.c2 = this.d2 = this.e2 = this.h2 = this.l2 = 0;
    this.ix = this.iy = 0;
    this.sp = 0;
    this.pc = 0;
    this.i = this.r = 0;
    this.wz = 0;
  }
}
