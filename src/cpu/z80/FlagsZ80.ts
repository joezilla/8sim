/**
 * Zilog Z80 flags register (F).
 *
 * Byte layout: S Z Y H X PV N C  (bit 7 → bit 0)
 *   S  (0x80) Sign
 *   Z  (0x40) Zero
 *   Y  (0x20) undocumented copy of result bit 5
 *   H  (0x10) Half-carry
 *   X  (0x08) undocumented copy of result bit 3
 *   PV (0x04) Parity / overflow (context-dependent)
 *   N  (0x02) Add/Subtract (set by subtractions)
 *   C  (0x01) Carry
 */
export class FlagsZ80 {
  s = false;
  z = false;
  y = false;
  h = false;
  x = false;
  pv = false;
  n = false;
  c = false;

  toByte(): number {
    return (
      (this.s ? 0x80 : 0) |
      (this.z ? 0x40 : 0) |
      (this.y ? 0x20 : 0) |
      (this.h ? 0x10 : 0) |
      (this.x ? 0x08 : 0) |
      (this.pv ? 0x04 : 0) |
      (this.n ? 0x02 : 0) |
      (this.c ? 0x01 : 0)
    );
  }

  fromByte(b: number): void {
    this.s = (b & 0x80) !== 0;
    this.z = (b & 0x40) !== 0;
    this.y = (b & 0x20) !== 0;
    this.h = (b & 0x10) !== 0;
    this.x = (b & 0x08) !== 0;
    this.pv = (b & 0x04) !== 0;
    this.n = (b & 0x02) !== 0;
    this.c = (b & 0x01) !== 0;
  }

  reset(): void {
    this.s = this.z = this.y = this.h = this.x = this.pv = this.n = this.c = false;
  }
}
