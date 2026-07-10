import { SystemClock } from '../clock/SystemClock.js';

/** Anything with a step() that executes one instruction and returns T-states. */
export interface ISteppable {
  step(): number;
}

/** Target CPU speed: a frequency in Hz, or 'max' for unthrottled execution. */
export type CpuSpeed = number | 'max';

export interface MachineRunnerOptions {
  /** Target CPU clock. Default 2 MHz — a stock 8080. */
  hz?: CpuSpeed;
  /**
   * Scheduler for the next tick. Defaults to setTimeout (browser-portable).
   * Node callers wanting maximum throughput in 'max' mode can pass
   * (fn, ms) => ms > 0 ? setTimeout(fn, ms) : setImmediate(fn).
   */
  schedule?: (fn: () => void, delayMs: number) => void;
  /** Called after the runner stops itself because step() threw. */
  onError?: (err: unknown) => void;
  /** Time source in ms. Default performance.now — override for tests. */
  now?: () => number;
}

/** Steps executed per tick in 'max' mode. */
const MAX_SPEED_BATCH = 40_000;
/** Longest uninterrupted wall-time slice while catching up (keeps I/O live). */
const MAX_SLICE_MS = 20;
/** Behind by more than this → forfeit the lost time instead of sprinting. */
const RESYNC_BEHIND_MS = 250;

/**
 * Drives a CPU's step() loop at a configurable real-time speed.
 *
 * Throttled mode runs the CPU in ~1 ms slices of simulated time and compares
 * simulated progress against wall time (absolute accounting via SystemClock,
 * so timer jitter self-corrects): ahead → sleep the difference; behind → keep
 * stepping up to MAX_SLICE_MS per tick, then yield so host I/O stays
 * responsive. Host stalls beyond RESYNC_BEHIND_MS are forfeited rather than
 * replayed at full speed.
 */
export class MachineRunner {
  private hz: CpuSpeed;
  private readonly clock: SystemClock;
  private readonly schedule: (fn: () => void, delayMs: number) => void;
  private readonly onError: (err: unknown) => void;
  private readonly now: () => number;
  private running = false;
  private startedAt = 0;
  private cyclesAtStart = 0n;

  constructor(private readonly cpu: ISteppable, options: MachineRunnerOptions = {}) {
    this.hz = options.hz ?? 2_000_000;
    this.now = options.now ?? (() => performance.now());
    this.clock = new SystemClock(typeof this.hz === 'number' ? this.hz : 2_000_000, this.now);
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.onError = options.onError ?? ((err) => { console.error('[MachineRunner]', err); });
  }

  get targetHz(): CpuSpeed {
    return this.hz;
  }

  /** Measured average speed in Hz since start() — for status displays. */
  get effectiveHz(): number {
    const wallSec = (this.now() - this.startedAt) / 1000;
    if (!this.running || wallSec <= 0) return 0;
    return Number(this.clock.getElapsedCycles() - this.cyclesAtStart) / wallSec;
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Total simulated T-states executed across the runner's lifetime. */
  get elapsedCycles(): bigint {
    return this.clock.getElapsedCycles();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.startedAt = this.now();
    this.cyclesAtStart = this.clock.getElapsedCycles();
    this.clock.resync();
    this.schedule(this.tick, 0);
  }

  stop(): void {
    this.running = false;
  }

  /** Change speed while running; pacing restarts from this moment. */
  setHz(hz: CpuSpeed): void {
    this.hz = hz;
    // Re-baseline either way: entering throttled mode after a 'max' stint
    // would otherwise see the simulation absurdly far ahead and sleep for it.
    this.clock.setHz(typeof hz === 'number' ? hz : this.clock.targetHz);
  }

  private readonly tick = (): void => {
    if (!this.running) return;
    try {
      if (this.hz === 'max') {
        for (let i = 0; i < MAX_SPEED_BATCH; i++) this.clock.addCycles(this.cpu.step());
        this.schedule(this.tick, 0);
        return;
      }

      // Host stalled (GC, suspended tab): forfeit the lost time.
      if (this.clock.getAheadMs() < -RESYNC_BEHIND_MS) this.clock.resync();

      const chunk = Math.max(1, Math.floor(this.hz / 1000)); // ~1 ms of simulated time
      const sliceStart = this.now();
      do {
        let cycles = 0;
        while (cycles < chunk) cycles += this.cpu.step();
        this.clock.addCycles(cycles);
      } while (this.clock.getAheadMs() < 0 && this.now() - sliceStart < MAX_SLICE_MS);

      const aheadMs = this.clock.getAheadMs();
      this.schedule(this.tick, aheadMs > 1 ? Math.floor(aheadMs) : 0);
    } catch (err) {
      this.running = false;
      this.onError(err);
    }
  };
}
