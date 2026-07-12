/**
 * Minimal common surface shared by every CPU core (Cpu8080, CpuZ80).
 *
 * Deliberately lightweight: it does NOT expose the register file or flags,
 * because those differ between CPUs. It re-declares `step(): number`, so any
 * ICpu is structurally assignable to `ISteppable` (src/machine/MachineRunner.ts)
 * and can be driven by MachineRunner without either module importing the other.
 */
export interface ICpu {
  /** Execute one instruction (or service one pending interrupt); returns T-states consumed. */
  step(): number;
  /** Clear all registers, flags, and internal state to power-on defaults. */
  reset(): void;
  /** Run until halted or `maxCycles` T-states elapse; returns total T-states executed. */
  run(maxCycles?: number): bigint;
  /** True while the CPU is halted (HLT/HALT executed, awaiting an interrupt). */
  halted: boolean;
  /** Program counter, proxying the underlying register file. */
  pc: number;
  /** A uniform read-only register/flags snapshot for introspection (front panel,
   * debuggers) — the common 8-bit registers both cores share. */
  state(): CpuState;
}

/** A CPU register/flags snapshot — the registers common to the 8080 and Z80. */
export interface CpuState {
  pc: number;
  sp: number;
  a: number;
  /** Flags packed to a byte (PSW low byte on the 8080; F on the Z80). */
  f: number;
  b: number;
  c: number;
  d: number;
  e: number;
  h: number;
  l: number;
  halted: boolean;
  /** Interrupt-enable flip-flop (8080 INTE / Z80 IFF1) — drives the panel INTE lamp. */
  inte: boolean;
  /** A maskable interrupt is currently asserted at the controller — the INT lamp. */
  intPending: boolean;
  /** 8080 status byte of the last instruction — drives the panel machine-cycle
   * lamps (MEMR/INP/M1/OUT/STACK/WO/HLTA/INTA). See `status8080.ts`. */
  status: number;
}
