import type { IClock } from '../interfaces/IClock.js';

/**
 * A real-time clock that throttles execution to match a target CPU frequency.
 * Uses performance.now() for timing — works in Node 16+, all browsers, Deno, Bun.
 * Uses setTimeout(fn, 0) for yielding — no setImmediate or process.* dependencies.
 */
export class SystemClock implements IClock {
  private elapsed = 0n;
  private readonly hz: number;
  private startTime: number;
  private cyclesAtStart = 0n;

  constructor(hz = 2_000_000) {
    this.hz = hz;
    this.startTime = performance.now();
  }

  addCycles(cycles: number): void {
    this.elapsed += BigInt(cycles);
  }

  getElapsedCycles(): bigint {
    return this.elapsed;
  }

  reset(): void {
    this.elapsed = 0n;
    this.startTime = performance.now();
    this.cyclesAtStart = 0n;
  }

  /**
   * Returns a promise that resolves after yielding to the event loop.
   * Callers should await this periodically to avoid blocking.
   */
  yield(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /**
   * How far ahead (in ms) we are relative to wall time.
   * Positive = running too fast (should slow down).
   */
  getAheadMs(): number {
    const wallMs = performance.now() - this.startTime;
    const simMs = Number(this.elapsed - this.cyclesAtStart) / this.hz * 1000;
    return simMs - wallMs;
  }
}
