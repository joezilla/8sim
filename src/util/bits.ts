export function u8(v: number): number {
  return v & 0xff;
}

export function u16(v: number): number {
  return v & 0xffff;
}

export function signBit(v: number): boolean {
  return (v & 0x80) !== 0;
}

export function zeroFlag(v: number): boolean {
  return (v & 0xff) === 0;
}

export function parityFlag(v: number): boolean {
  let x = v & 0xff;
  x ^= x >> 4;
  x ^= x >> 2;
  x ^= x >> 1;
  return (x & 1) === 0;
}

export function auxCarryAdd(a: number, b: number, carry = 0): boolean {
  return ((a & 0xf) + (b & 0xf) + carry) > 0xf;
}

export function auxCarrySub(a: number, b: number, borrow = 0): boolean {
  return ((a & 0xf) - (b & 0xf) - borrow) < 0;
}

export function toWord(hi: number, lo: number): number {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

export function hi(w: number): number {
  return (w >> 8) & 0xff;
}

export function lo(w: number): number {
  return w & 0xff;
}
