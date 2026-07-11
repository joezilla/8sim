import type { IInterruptController } from '../interfaces/IInterruptController.js';
import type { IS100Card } from '../interfaces/IS100Card.js';
import type { ICpu } from '../interfaces/ICpu.js';
import type { Bus } from '../bus/Bus.js';
import type { MachineRunner } from './MachineRunner.js';

/**
 * Normative declarative description of a machine (AD-1). `buildMachine(spec)`
 * turns this into a running Bus+CPU+cards deterministically. Kept 8sim-native
 * and minimal: the rich, portable "Machine Profile" (catalog, identity,
 * versioning) lives in fdcplus-web; the MachineSpec is only what the engine
 * needs to construct a machine.
 *
 * Per AD-2 the engine is code-loading-agnostic: a card entry carries an
 * ALREADY-LOADED `factory` (a live function), never a bundle reference — 8sim
 * never imports anything.
 */

/** Closed CPU enum — no silent default. */
export type CpuKind = 'i8080' | 'z80';

/** Target clock: a frequency in Hz, or unthrottled. */
export type Clock = { hz: number } | 'max';

/** A typed memory region. `mmio` is reserved for forward-compat; cards provide
 * memory-mapped I/O via MemoryMappedIOAdapter at attach time, so buildMachine
 * supports `ram` and `rom` and rejects `mmio` in this build. */
export interface MemoryRegionSpec {
  id: string;
  base: number; // 16-bit start address
  size: number; // bytes; for `rom`, must equal image.length
  kind: 'ram' | 'rom' | 'mmio';
  image?: Uint8Array; // required for `rom`; optional initial fill for `ram`
}

/** Instance-scoped dependencies injected into a card factory (AD-5). 8sim
 * supplies `pic` and `log`; the caller (fdcplus-web) supplies the FDC channel
 * and anything else through `services`. Dumb cards ignore it. */
export interface CardContext {
  pic: IInterruptController;
  log: (message: string) => void;
  services: Record<string, unknown>;
}

/** An already-loaded card factory (AD-2). */
export type CardFactory = (
  id: string,
  config: Record<string, unknown>,
  ctx: CardContext,
) => IS100Card;

export interface CardSpec {
  id: string;
  factory: CardFactory;
  config?: Record<string, unknown>;
  /** Declared bus resources, used for define-time collision rejection (AD-1).
   * The engine's IoSpace is last-writer-wins and the PIC has no ownership, so
   * buildMachine asserts these are collision-free rather than trusting silence. */
  claims?: {
    ports?: number[];
    irq?: number | null;
  };
}

export interface MachineSpec {
  cpuKind: CpuKind;
  clock: Clock;
  /** Program counter at power-on (e.g. 0xFF00 for CDBL). Construction is data,
   * not an imperative `cpu.pc = …` step. */
  resetVector: number;
  /** Memory regions; attached in array order (overlaps are rejected). */
  memory: MemoryRegionSpec[];
  /** Cards in slot order; attached after memory, before the CPU runs. */
  cards: CardSpec[];
}

/** The runnable handle buildMachine returns. */
export interface Machine {
  cpu: ICpu;
  bus: Bus;
  pic: IInterruptController;
  cards: IS100Card[];
  runner: MachineRunner;
  spec: MachineSpec;
}

/** Thrown when a MachineSpec is invalid or would build an inconsistent machine.
 * Plain Error subclass — 8sim stays zero-dep and browser-portable. */
export class MachineSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MachineSpecError';
  }
}
