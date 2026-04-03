/**
 * Intel 8080 flags register.
 * Stored in PSW byte format: S Z 0 AC 0 P 1 CY
 * Bits: 7=S, 6=Z, 5=0, 4=AC, 3=0, 2=P, 1=1, 0=CY
 */
export class Flags {
  s = false;   // Sign
  z = false;   // Zero
  ac = false;  // Auxiliary Carry (half-carry)
  p = false;   // Parity (even)
  cy = false;  // Carry

  /** Serialize to PSW byte */
  toByte(): number {
    return (
      (this.s  ? 0x80 : 0) |
      (this.z  ? 0x40 : 0) |
      (this.ac ? 0x10 : 0) |
      (this.p  ? 0x04 : 0) |
      0x02 |                  // bit 1 always 1
      (this.cy ? 0x01 : 0)
    );
  }

  /** Deserialize from PSW byte */
  fromByte(b: number): void {
    this.s  = (b & 0x80) !== 0;
    this.z  = (b & 0x40) !== 0;
    this.ac = (b & 0x10) !== 0;
    this.p  = (b & 0x04) !== 0;
    this.cy = (b & 0x01) !== 0;
  }

  reset(): void {
    this.s = this.z = this.ac = this.p = this.cy = false;
  }
}
