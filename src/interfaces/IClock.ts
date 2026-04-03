export interface IClock {
  addCycles(cycles: number): void;
  getElapsedCycles(): bigint;
  reset(): void;
}
