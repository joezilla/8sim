import type { IModule } from './IModule.js';
import type { Bus } from '../bus/Bus.js';

export interface IS100Card extends IModule {
  attach(bus: Bus): void;
}
