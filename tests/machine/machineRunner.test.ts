import { describe, it, expect } from 'vitest';
import { MachineRunner, type ISteppable } from '../../src/machine/MachineRunner.js';

/**
 * Deterministic harness: fake wall clock + captured scheduler. Driving a
 * scheduled callback advances the fake clock by its requested delay, so the
 * runner experiences exactly the time it asked for.
 */
class Harness {
  time = 0;
  private queue: Array<{ fn: () => void; delay: number }> = [];
  steps = 0;

  readonly cpu: ISteppable;

  constructor(tStatesPerStep = 4, stepImpl?: () => number) {
    this.cpu = {
      step: () => {
        this.steps++;
        return stepImpl ? stepImpl() : tStatesPerStep;
      },
    };
  }

  makeRunner(hz: number | 'max' | undefined, onError?: (e: unknown) => void): MachineRunner {
    return new MachineRunner(this.cpu, {
      ...(hz !== undefined ? { hz } : {}),
      now: () => this.time,
      schedule: (fn, delay) => this.queue.push({ fn, delay }),
      ...(onError ? { onError } : {}),
    });
  }

  /** Run the next scheduled tick, advancing fake time by its delay. */
  driveOne(): number {
    const next = this.queue.shift();
    if (!next) throw new Error('nothing scheduled');
    this.time += next.delay;
    next.fn();
    return next.delay;
  }

  /** Drive ticks until the fake clock passes the given time. */
  driveUntil(untilMs: number): void {
    let guard = 100_000;
    while (this.time < untilMs && this.queue.length > 0 && guard-- > 0) this.driveOne();
    if (guard <= 0) throw new Error('runaway scheduler');
  }

  get pendingDelay(): number {
    return this.queue[0]?.delay ?? -1;
  }

  get pendingCount(): number {
    return this.queue.length;
  }
}

describe('MachineRunner — throttled pacing', () => {
  it('defaults to 2 MHz and executes ~2M cycles per simulated second', () => {
    const h = new Harness(4);
    const runner = h.makeRunner(undefined);
    expect(runner.targetHz).toBe(2_000_000);

    runner.start();
    h.driveUntil(1000); // one simulated second of wall time
    const cycles = Number(runner.elapsedCycles);
    expect(cycles).toBeGreaterThan(1_900_000);
    expect(cycles).toBeLessThan(2_100_000);
    runner.stop();
  });

  it('paces a 4 MHz target at roughly double the 2 MHz cycle count', () => {
    const h = new Harness(7); // odd T-state count exercises chunk boundaries
    const runner = h.makeRunner(4_000_000);
    runner.start();
    h.driveUntil(500);
    const cycles = Number(runner.elapsedCycles);
    expect(cycles).toBeGreaterThan(1_900_000); // ~2M cycles in 500ms at 4MHz
    expect(cycles).toBeLessThan(2_100_000);
    runner.stop();
  });

  it('sleeps (schedules with a positive delay) when ahead of wall time', () => {
    const h = new Harness(4);
    const runner = h.makeRunner(2_000_000);
    runner.start();
    h.driveOne(); // initial tick: runs a chunk with no wall time elapsed → ahead
    // The runner is now ahead of wall time; some subsequent schedule must carry
    // a positive delay rather than a hot 0ms loop.
    let sawSleep = false;
    for (let i = 0; i < 5 && !sawSleep; i++) {
      if (h.pendingDelay > 0) sawSleep = true;
      else h.driveOne();
    }
    expect(sawSleep).toBe(true);
    runner.stop();
  });

  it('forfeits time lost to a long host stall instead of sprinting to catch up', () => {
    const h = new Harness(4);
    const runner = h.makeRunner(2_000_000);
    runner.start();
    h.driveUntil(100);
    const before = Number(runner.elapsedCycles);

    h.time += 10_000; // host stalls for 10 seconds
    h.driveOne();     // next tick resyncs instead of replaying 10s of cycles

    const after = Number(runner.elapsedCycles);
    // 10s at 2MHz would be 20M cycles; a resynced tick runs only a few slices.
    expect(after - before).toBeLessThan(200_000);
    runner.stop();
  });
});

describe('MachineRunner — max speed', () => {
  it('runs fixed batches with zero-delay scheduling and no sleeping', () => {
    const h = new Harness(4);
    const runner = h.makeRunner('max');
    runner.start();
    h.driveOne();
    const afterOneTick = h.steps;
    expect(afterOneTick).toBe(40_000);
    expect(h.pendingDelay).toBe(0); // never sleeps
    h.driveOne();
    expect(h.steps).toBe(80_000);
    runner.stop();
  });
});

describe('MachineRunner — speed changes', () => {
  it('setHz mid-run changes the pace from that moment', () => {
    const h = new Harness(4);
    const runner = h.makeRunner(2_000_000);
    runner.start();
    h.driveUntil(500);
    const at2mhz = Number(runner.elapsedCycles);

    runner.setHz(4_000_000);
    h.driveUntil(1000);
    const delta = Number(runner.elapsedCycles) - at2mhz;
    expect(delta).toBeGreaterThan(1_900_000); // 500ms at 4MHz ≈ 2M cycles
    expect(delta).toBeLessThan(2_100_000);
    runner.stop();
  });

  it('switching max → throttled re-baselines instead of sleeping off the surplus', () => {
    const h = new Harness(4);
    const runner = h.makeRunner('max');
    runner.start();
    for (let i = 0; i < 20; i++) h.driveOne(); // pile up 3.2M unpaced cycles

    runner.setHz(2_000_000);
    h.driveOne();
    // Without a re-baseline the runner would think it is ~1.6 simulated
    // seconds ahead and schedule a giant sleep.
    expect(h.pendingDelay).toBeLessThan(50);
    runner.stop();
  });
});

describe('MachineRunner — lifecycle', () => {
  it('stop() halts stepping even with a tick still scheduled', () => {
    const h = new Harness(4);
    const runner = h.makeRunner(2_000_000);
    runner.start();
    h.driveOne();
    const stepsAtStop = h.steps;
    runner.stop();
    while (h.pendingCount > 0) h.driveOne();
    expect(h.steps).toBe(stepsAtStop);
    expect(runner.isRunning).toBe(false);
  });

  it('start() is idempotent while running', () => {
    const h = new Harness(4);
    const runner = h.makeRunner(2_000_000);
    runner.start();
    runner.start();
    expect(h.pendingCount).toBe(1); // no double tick chain
    runner.stop();
  });

  it('a throwing step() stops the runner and reports via onError', () => {
    let seen: unknown = null;
    const h = new Harness(4, () => { throw new Error('boom'); });
    const runner = h.makeRunner(2_000_000, (e) => { seen = e; });
    runner.start();
    h.driveOne();
    expect(String(seen)).toContain('boom');
    expect(runner.isRunning).toBe(false);
    expect(h.pendingCount).toBe(0); // no further ticks scheduled
  });

  it('reports a plausible effectiveHz while running', () => {
    const h = new Harness(4);
    const runner = h.makeRunner(2_000_000);
    runner.start();
    h.driveUntil(1000);
    expect(runner.effectiveHz).toBeGreaterThan(1_500_000);
    expect(runner.effectiveHz).toBeLessThan(2_500_000);
    runner.stop();
  });
});
