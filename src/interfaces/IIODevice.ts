import type { IModule } from './IModule.js';

export interface IIODevice extends IModule {
  readonly basePorts: ReadonlyArray<number>;
  ioRead(port: number): number;
  ioWrite(port: number, value: number): void;
}
