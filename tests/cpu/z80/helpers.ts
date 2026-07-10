import { CpuZ80 } from '../../../src/cpu/z80/CpuZ80.js';
import { InterruptController } from '../../../src/interrupt/InterruptController.js';
import { Bus } from '../../../src/bus/Bus.js';
import { Ram } from '../../../src/memory/Ram.js';

export interface Z80Harness {
  cpu: CpuZ80;
  ram: Ram;
  bus: Bus;
  pic: InterruptController;
}

/** Build a Z80 with `program` loaded at 0x0000 in a full 64K RAM. */
export function makeZ80(program: number[] = [], loadAt = 0): Z80Harness {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0, 0x10000);
  if (program.length) ram.load(new Uint8Array(program), loadAt);
  bus.attachMemory(ram);
  const cpu = new CpuZ80(bus, pic);
  return { cpu, ram, bus, pic };
}

/** Step once and return the T-states reported. */
export function step1(h: Z80Harness): number {
  return h.cpu.step();
}
