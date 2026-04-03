import type { IClock } from '../interfaces/IClock.js';

export class ImmediateClock implements IClock {
  private elapsed = 0n;

  addCycles(cycles: number): void {
    this.elapsed += BigInt(cycles);
  }

  getElapsedCycles(): bigint {
    return this.elapsed;
  }

  reset(): void {
    this.elapsed = 0n;
  }
}
