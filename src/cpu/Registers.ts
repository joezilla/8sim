export class Registers {
  a = 0;
  b = 0;
  c = 0;
  d = 0;
  e = 0;
  h = 0;
  l = 0;
  sp = 0;
  pc = 0;

  /** BC register pair */
  get bc(): number { return (this.b << 8) | this.c; }
  set bc(v: number) { this.b = (v >> 8) & 0xff; this.c = v & 0xff; }

  /** DE register pair */
  get de(): number { return (this.d << 8) | this.e; }
  set de(v: number) { this.d = (v >> 8) & 0xff; this.e = v & 0xff; }

  /** HL register pair */
  get hl(): number { return (this.h << 8) | this.l; }
  set hl(v: number) { this.h = (v >> 8) & 0xff; this.l = v & 0xff; }

  reset(): void {
    this.a = this.b = this.c = this.d = this.e = this.h = this.l = 0;
    this.sp = 0;
    this.pc = 0;
  }
}
