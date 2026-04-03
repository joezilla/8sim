import type { IMemory } from '../interfaces/IMemory.js';

export interface BusRegion {
  readonly start: number;
  readonly end: number; // inclusive
  readonly module: IMemory;
}

export function createRegion(module: IMemory): BusRegion {
  return {
    start: module.baseAddress,
    end: module.baseAddress + module.size - 1,
    module,
  };
}
