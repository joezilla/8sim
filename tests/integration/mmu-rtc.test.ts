import { describe, it, expect } from 'vitest';
import { buildMachine } from '../../src/machine/buildMachine.js';
import { bankRamKernel, rtcKernel } from '../../src/bundles/kernels.js';
import type { CardSpec } from '../../src/machine/MachineSpec.js';

/** Story 5.10 end-to-end: a bank-switch RAM window and an MM58167 RTC, driven
 * through the real Bus + IoSpace exactly as a running machine would. */
function cardOf(kernel: { create: CardSpec['factory']; claims: (c: Record<string, unknown>) => { ports?: number[] } }, id: string, config: Record<string, unknown>): CardSpec {
  return { id, factory: kernel.create, config, claims: kernel.claims(config) };
}

describe('bank-switch RAM + RTC through the Bus', () => {
  it('bank RAM coexists with base RAM and swaps on the select port', () => {
    const m = buildMachine(
      {
        cpuKind: 'i8080',
        clock: 'max',
        resetVector: 0,
        memory: [{ id: 'base', base: 0, size: 0xc000, kind: 'ram' }], // 0x0000–0xBFFF
        cards: [cardOf(bankRamKernel, 'mmu', { window: 0xc000, size: 0x1000, banks: 4, selectPort: 0x40 })],
      },
      { services: {} },
    );
    // base RAM still works
    m.bus.write(0x1234, 0x5a);
    expect(m.bus.read(0x1234)).toBe(0x5a);
    // bank 0 then bank 1 at the same window address
    m.bus.ioWrite(0x40, 0);
    m.bus.write(0xc000, 0xaa);
    m.bus.ioWrite(0x40, 1);
    m.bus.write(0xc000, 0xbb);
    expect(m.bus.read(0xc000)).toBe(0xbb);
    m.bus.ioWrite(0x40, 0);
    expect(m.bus.read(0xc000)).toBe(0xaa);
  });

  it('RTC reads the injected host clock as BCD', () => {
    const m = buildMachine(
      {
        cpuKind: 'i8080',
        clock: 'max',
        resetVector: 0,
        memory: [{ id: 'ram', base: 0, size: 0x1000, kind: 'ram' }],
        cards: [cardOf(rtcKernel, 'clk', { base: 0x50 })],
      },
      { services: { clock: () => new Date(2026, 6, 12, 9, 5, 0) } },
    );
    expect(m.bus.ioRead(0x52)).toBe(0x00); // seconds
    expect(m.bus.ioRead(0x53)).toBe(0x05); // minutes
    expect(m.bus.ioRead(0x54)).toBe(0x09); // hours
  });
});
