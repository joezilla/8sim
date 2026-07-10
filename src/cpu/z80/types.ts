import type { IBus } from '../../interfaces/IBus.js';
import type { RegistersZ80 } from './RegistersZ80.js';
import type { FlagsZ80 } from './FlagsZ80.js';

/**
 * The core surface that instruction handlers operate on. {@link CpuZ80}
 * implements it. Instruction tables import only this interface (never CpuZ80),
 * keeping the dependency graph acyclic.
 */
export interface Z80Core {
  readonly regs: RegistersZ80;
  readonly flags: FlagsZ80;
  readonly bus: IBus;

  iff1: boolean;
  iff2: boolean;
  im: 0 | 1 | 2;
  pendingEI: boolean;
  halted: boolean;

  /** Read the byte at PC and advance PC (a normal operand fetch — no R increment). */
  fetchByte(): number;
  /** Read a little-endian word at PC and advance PC by 2. */
  fetchWord(): number;
  /** Push a 16-bit value (SP -= 2, little-endian). */
  push16(v: number): void;
  /** Pop a 16-bit value (SP += 2). */
  pop16(): number;
}

/** An instruction handler: mutates core state, returns T-states from the opcode byte onward. */
export type Z80Handler = (cpu: Z80Core) => number;

/** A DDCB/FDCB handler: the effective address is precomputed by the dispatcher. */
export type Z80IndexedCbHandler = (cpu: Z80Core, addr: number) => number;

/**
 * Parameterizes the main instruction table over the active 16-bit pointer:
 * HL (unprefixed), IX (DD prefix), or IY (FD prefix). The same registration
 * factories build all three tables, so undocumented IXH/IXL/IYH/IYL forms and
 * the (IX+d)/(IY+d) memory forms fall out automatically.
 */
export interface IndexView {
  readonly kind: 'hl' | 'ix' | 'iy';
  /** True for the IX/IY views. */
  readonly indexed: boolean;
  /** Extra T-states an indexed memory access adds over the HL form (0 for hl, 8 for ix/iy). */
  readonly memExtra: number;

  /** The active 16-bit pointer pair (HL / IX / IY). */
  getPair(r: RegistersZ80): number;
  setPair(r: RegistersZ80, v: number): void;

  /** High byte of the pointer (H / IXH / IYH) — the "displaced" register operand. */
  getHi(r: RegistersZ80): number;
  setHi(r: RegistersZ80, v: number): void;
  /** Low byte of the pointer (L / IXL / IYL). */
  getLo(r: RegistersZ80): number;
  setLo(r: RegistersZ80, v: number): void;

  /**
   * Effective memory address for (HL) / (IX+d) / (IY+d). For indexed views this
   * fetches the displacement byte (advancing PC) and sets WZ to the computed
   * address. Call at most once per instruction.
   */
  memAddr(cpu: Z80Core): number;
}
