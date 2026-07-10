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
}
