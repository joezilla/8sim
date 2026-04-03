import type { IModule } from './IModule.js';

export interface IInterruptController extends IModule {
  hasPendingInterrupt(): boolean;
  acknowledge(): number;
  assertIRQ(line: number): void;
  clearIRQ(line: number): void;
}
