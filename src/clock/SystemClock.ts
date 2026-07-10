import type { IClock } from '../interfaces/IClock.js';

/**
 * A real-time clock that tracks how far the simulation has run relative to a
 * target CPU frequency. Uses performance.now() for timing — works in Node 16+,
 * all browsers, Deno, Bun. Uses setTimeout(fn, 0) for yielding — no
 * setImmediate or process.* dependencies.
 *
 * Drift accounting is absolute (cycles vs. wall time since the last baseline),
 * so oversleeping or scheduler jitter self-corrects instead of accumulating.
 */
export class SystemClock implements IClock {
  private elapsed = 0n;
  private hz: number;
  private startTime: number;
  private cyclesAtStart = 0n;
  private readonly now: () => number;

  constructor(hz = 2_000_000, now: () => number = () => performance.now()) {
    this.hz = hz;
    this.now = now;
    this.startTime = now();
  }

  addCycles(cycles: number): void {
    this.elapsed += BigInt(cycles);
  }

  getElapsedCycles(): bigint {
    return this.elapsed;
  }

  reset(): void {
    this.elapsed = 0n;
    this.rebaseline();
  }

  get targetHz(): number {
    return this.hz;
  }

  /**
   * Change the target frequency. Re-baselines so the new rate applies from
   * this moment — cycles already executed are not retroactively repriced.
   */
  setHz(hz: number): void {
    this.rebaseline();
    this.hz = hz;
  }

  /**
   * Forfeit any accumulated drift and restart pacing from "now". Used after
   * host stalls (GC pause, suspended tab) so the simulation doesn't sprint to
   * catch up on lost wall time.
   */
  resync(): void {
    this.rebaseline();
  }

  /**
   * Returns a promise that resolves after yielding to the event loop.
   * Callers should await this periodically to avoid blocking.
   */
  yield(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  /**
   * How far ahead (in ms) the simulation is relative to wall time.
   * Positive = running too fast (should sleep); negative = behind.
   */
  getAheadMs(): number {
    const wallMs = this.now() - this.startTime;
    const simMs = Number(this.elapsed - this.cyclesAtStart) / this.hz * 1000;
    return simMs - wallMs;
  }

  private rebaseline(): void {
    this.cyclesAtStart = this.elapsed;
    this.startTime = this.now();
  }
}
