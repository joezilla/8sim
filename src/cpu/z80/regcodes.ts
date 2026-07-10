import type { RegistersZ80 } from './RegistersZ80.js';
import type { IndexView } from './types.js';

/**
 * 8-bit register access by the 3-bit opcode field (B,C,D,E,H,L,(HL),A).
 * Code 6 is the memory operand and is handled by callers (via {@link IndexView.memAddr}),
 * never by these helpers.
 *
 * In an IX/IY view, codes 4 and 5 map to IXH/IXL (or IYH/IYL) — EXCEPT when the
 * instruction also has a memory operand (an `LD r,(IX+d)` form), in which case H
 * and L stay real. Those cases use the `*Real*` variants.
 */

/** Read register `code` honoring the index view for H/L (→ IXH/IXL). */
export function getR(regs: RegistersZ80, view: IndexView, code: number): number {
  switch (code) {
    case 0: return regs.b;
    case 1: return regs.c;
    case 2: return regs.d;
    case 3: return regs.e;
    case 4: return view.getHi(regs);
    case 5: return view.getLo(regs);
    case 7: return regs.a;
    default: return 0; // code 6 (memory) handled by caller
  }
}

/** Write register `code` honoring the index view for H/L. */
export function setR(regs: RegistersZ80, view: IndexView, code: number, v: number): void {
  const b = v & 0xff;
  switch (code) {
    case 0: regs.b = b; break;
    case 1: regs.c = b; break;
    case 2: regs.d = b; break;
    case 3: regs.e = b; break;
    case 4: view.setHi(regs, b); break;
    case 5: view.setLo(regs, b); break;
    case 7: regs.a = b; break;
    // code 6 handled by caller
  }
}

/** Read register `code` using the real H/L (never index-substituted). */
export function getRealR(regs: RegistersZ80, code: number): number {
  switch (code) {
    case 0: return regs.b;
    case 1: return regs.c;
    case 2: return regs.d;
    case 3: return regs.e;
    case 4: return regs.h;
    case 5: return regs.l;
    case 7: return regs.a;
    default: return 0;
  }
}

/** Write register `code` using the real H/L. */
export function setRealR(regs: RegistersZ80, code: number, v: number): void {
  const b = v & 0xff;
  switch (code) {
    case 0: regs.b = b; break;
    case 1: regs.c = b; break;
    case 2: regs.d = b; break;
    case 3: regs.e = b; break;
    case 4: regs.h = b; break;
    case 5: regs.l = b; break;
    case 7: regs.a = b; break;
  }
}

/** Human-readable operand name for debugging/tests. */
export const REG_NAMES = ['B', 'C', 'D', 'E', 'H', 'L', '(HL)', 'A'] as const;
