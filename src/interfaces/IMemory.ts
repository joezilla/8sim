import type { IModule } from './IModule.js';

export interface IMemory extends IModule {
  readonly baseAddress: number;
  readonly size: number;
  readonly readOnly: boolean;
  read(offset: number): number;
  write(offset: number, value: number): void;
}
