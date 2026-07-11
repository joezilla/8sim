import { Bus } from '../bus/Bus.js';
import { Ram } from '../memory/Ram.js';
import { Rom } from '../memory/Rom.js';
import { InterruptController } from '../interrupt/InterruptController.js';
import { Cpu8080 } from '../cpu/Cpu8080.js';
import { CpuZ80 } from '../cpu/z80/CpuZ80.js';
import { MachineRunner } from './MachineRunner.js';
import type { IS100Card } from '../interfaces/IS100Card.js';
import {
  MachineSpecError,
  type MachineSpec,
  type Machine,
  type MemoryRegionSpec,
  type CardContext,
} from './MachineSpec.js';

export interface BuildOptions {
  /** Per-machine logger injected into each card's CardContext. */
  log?: (message: string) => void;
  /** Caller-supplied instance-scoped services (e.g. the FDC channel a disk
   * controller card pulls from `ctx.services`). */
  services?: Record<string, unknown>;
}

const inU16 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= 0xffff;
const regionEnd = (r: MemoryRegionSpec): number => r.base + r.size - 1;

/**
 * Validate a MachineSpec and build a runnable machine (AD-1, AD-2).
 *
 * Construction order is pinned: memory regions (array order) → cards (slot
 * order) → CPU. All collisions are rejected here — the Bus is first-region-wins
 * and IoSpace is last-writer-wins, so a silently-overlapping spec would produce
 * a wrong machine. `buildMachine` never loads code: each card entry carries an
 * already-loaded factory.
 */
export function buildMachine(spec: MachineSpec, opts: BuildOptions = {}): Machine {
  validate(spec);

  const pic = new InterruptController();
  const bus = new Bus(pic);

  // 1) Memory regions, in array order.
  for (const region of spec.memory) {
    if (region.kind === 'rom') {
      bus.attachMemory(new Rom(region.id, region.base, region.image as Uint8Array));
    } else {
      // ram
      const ram = new Ram(region.id, region.base, region.size);
      if (region.image) {
        for (let i = 0; i < region.image.length; i++) ram.write(i, region.image[i] as number);
      }
      bus.attachMemory(ram);
    }
  }

  // 2) Cards, in slot order. Each factory is already loaded (AD-2).
  const ctx: CardContext = {
    pic,
    log: opts.log ?? (() => {}),
    services: opts.services ?? {},
  };
  const cards: IS100Card[] = [];
  for (const card of spec.cards) {
    const built = card.factory(card.id, card.config ?? {}, ctx);
    built.attach(bus);
    cards.push(built);
  }

  // 3) CPU last; power-on PC comes from the spec, not an imperative step.
  const cpu = spec.cpuKind === 'z80' ? new CpuZ80(bus, pic) : new Cpu8080(bus, pic);
  cpu.reset();
  cpu.pc = spec.resetVector;

  const runner = new MachineRunner(cpu, { hz: spec.clock === 'max' ? 'max' : spec.clock.hz });

  return { cpu, bus, pic, cards, runner, spec };
}

function validate(spec: MachineSpec): void {
  if (spec.cpuKind !== 'i8080' && spec.cpuKind !== 'z80') {
    throw new MachineSpecError(`cpuKind must be "i8080" or "z80", got ${JSON.stringify(spec.cpuKind)}`);
  }
  if (spec.clock !== 'max' && !(typeof spec.clock === 'object' && spec.clock.hz > 0)) {
    throw new MachineSpecError(`clock must be "max" or { hz: >0 }, got ${JSON.stringify(spec.clock)}`);
  }
  if (!inU16(spec.resetVector)) {
    throw new MachineSpecError(`resetVector must be an integer in 0x0000..0xFFFF, got ${spec.resetVector}`);
  }

  // Memory regions: shape + bounds.
  for (const r of spec.memory) {
    if (r.kind === 'mmio') {
      throw new MachineSpecError(
        `memory region "${r.id}": kind "mmio" is not supported by buildMachine (memory-mapped I/O is provided by cards)`,
      );
    }
    if (!inU16(r.base) || !Number.isInteger(r.size) || r.size < 1 || r.base + r.size > 0x10000) {
      throw new MachineSpecError(
        `memory region "${r.id}": invalid base/size (base=${r.base}, size=${r.size}); must fit within 0x0000..0xFFFF`,
      );
    }
    if (r.kind === 'rom' && (!r.image || r.image.length !== r.size)) {
      throw new MachineSpecError(
        `memory region "${r.id}": rom requires an image whose length (${r.image?.length ?? 0}) equals size (${r.size})`,
      );
    }
  }

  // Memory overlaps: sort a copy by base, check neighbours.
  const sorted = [...spec.memory].sort((a, b) => a.base - b.base);
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i] as MemoryRegionSpec;
    const b = sorted[i + 1] as MemoryRegionSpec;
    if (regionEnd(a) >= b.base) {
      throw new MachineSpecError(
        `memory regions overlap: "${a.id}" (0x${a.base.toString(16)}-0x${regionEnd(a).toString(16)}) and ` +
          `"${b.id}" (0x${b.base.toString(16)}-0x${regionEnd(b).toString(16)})`,
      );
    }
  }

  // I/O port collisions across card claims.
  const portOwner = new Map<number, string>();
  for (const card of spec.cards) {
    for (const port of card.claims?.ports ?? []) {
      const prev = portOwner.get(port & 0xff);
      if (prev !== undefined) {
        throw new MachineSpecError(
          `I/O port 0x${(port & 0xff).toString(16)} claimed by both "${prev}" and "${card.id}"`,
        );
      }
      portOwner.set(port & 0xff, card.id);
    }
  }

  // IRQ line collisions across card claims.
  const irqOwner = new Map<number, string>();
  for (const card of spec.cards) {
    const irq = card.claims?.irq;
    if (irq === undefined || irq === null) continue;
    const prev = irqOwner.get(irq);
    if (prev !== undefined) {
      throw new MachineSpecError(`IRQ line ${irq} claimed by both "${prev}" and "${card.id}"`);
    }
    irqOwner.set(irq, card.id);
  }
}
