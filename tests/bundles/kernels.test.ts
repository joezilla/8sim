import { describe, it, expect } from 'vitest';
import { kernels, kernelById, serialKernel, parallelKernel, vdmKernel } from '../../src/bundles/kernels.js';
import { withDefaults } from '../../src/bundles/CardBundle.js';
import { buildMachine } from '../../src/machine/buildMachine.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import type { CardContext } from '../../src/machine/MachineSpec.js';

const ctx: CardContext = { pic: new InterruptController(), log: () => {}, services: {} };

describe('card behavior kernels (Story 5.7)', () => {
  it('registers the serial kernel, bound to a terminal', () => {
    expect(kernelById('serial')).toBe(serialKernel);
    expect(serialKernel.binding).toBe('terminal');
    expect(Object.keys(serialKernel.configSchema)).toEqual(['dataPort', 'ctrlPort', 'chip']);
  });

  it('builds a console-capable serial card that exposes a channel', () => {
    const cfg = withDefaults(
      { name: 'x', version: '1.0.0', type: 'serial', configSchema: serialKernel.configSchema },
      { dataPort: 0x12, ctrlPort: 0x13 },
    );
    const card = serialKernel.create('sc', cfg, ctx) as { channel?: { onTransmit: unknown; enqueueRx: unknown } };
    // ConsoleHub wires a card by its `.channel` — the whole point of a card kernel
    // over a bare deviceCard-wrapped chip (which hides the channel).
    expect(card.channel).toBeDefined();
    expect(typeof card.channel!.onTransmit).toBe('function');
    expect(typeof card.channel!.enqueueRx).toBe('function');
    expect(serialKernel.claims(cfg).ports).toEqual([0x12, 0x13]);
  });

  it('a machine built from a serial-kernel card round-trips a byte through the channel', () => {
    const cfg = withDefaults(
      { name: 'x', version: '1.0.0', type: 'serial', configSchema: serialKernel.configSchema },
      {},
    );
    const claims = serialKernel.claims(cfg);
    const machine = buildMachine({
      cpuKind: 'i8080',
      clock: 'max',
      resetVector: 0,
      memory: [{ id: 'ram', base: 0, size: 0x10000, kind: 'ram' }],
      cards: [{ id: 'ser', factory: serialKernel.create, config: cfg, claims }],
    });
    expect(machine.cards).toHaveLength(1);

    // The card the machine seated exposes the console channel.
    const card = machine.cards[0] as { channel?: { onTransmit: (cb: (b: number) => void) => void; enqueueRx: (b: number) => void } };
    const out: number[] = [];
    card.channel!.onTransmit((b) => out.push(b));
    card.channel!.enqueueRx(0x41); // 'A' available to the CPU to read
    expect(card.channel).toBeDefined();
  });

  it('supports a 6850 chip variant', () => {
    const cfg = withDefaults(
      { name: 'x', version: '1.0.0', type: 'serial', configSchema: serialKernel.configSchema },
      { chip: 'm6850', dataPort: 0x80, ctrlPort: 0x81 },
    );
    const card = serialKernel.create('sc', cfg, ctx) as { channel?: unknown };
    expect(card.channel).toBeDefined();
  });

  it('registers the parallel kernel, bound to gpio', () => {
    expect(kernelById('parallel')).toBe(parallelKernel);
    expect(parallelKernel.binding).toBe('gpio');
    expect(parallelKernel.claims({ port: 0xff }).ports).toEqual([0xff]);
  });

  it('registers the VDM kernel: a memory-mapped char display bound to a monitor', () => {
    expect(kernelById('vdm-video')).toBe(vdmKernel);
    expect(vdmKernel.binding).toBe('display');
    // The screen is memory-mapped; the one I/O port is DSTAT (scroll), default 0xFE.
    expect(vdmKernel.claims({}).ports).toEqual([0xfe]);
    expect(vdmKernel.claims({ dstatPort: 0xc8 }).ports).toEqual([0xc8]);
    // Declares its 1K video RAM as a region (overlap-validated + on the ribbon).
    expect(vdmKernel.memory!({ base: 0xcc00 })).toEqual([{ id: 'vram', base: 0xcc00, size: 0x400, kind: 'ram' }]);
  });

  it('the VDM display reflects what the CPU writes to video RAM (Story 5.9)', () => {
    const cfg = withDefaults(
      { name: 'x', version: '1.0.0', type: 'video', configSchema: vdmKernel.configSchema },
      { base: 0xcc00 },
    );
    const machine = buildMachine({
      cpuKind: 'i8080',
      clock: 'max',
      resetVector: 0,
      // MVI A,'H'(0x48) ; STA 0xCC00 ; MVI A,'i'(0x69) ; STA 0xCC01 ; HLT
      memory: [
        { id: 'rom', base: 0, size: 11, kind: 'rom', image: new Uint8Array([0x3e, 0x48, 0x32, 0x00, 0xcc, 0x3e, 0x69, 0x32, 0x01, 0xcc, 0x76]) },
        ...vdmKernel.memory!(cfg), // the video RAM region
      ],
      cards: [{ id: 'vdm', factory: vdmKernel.create, config: cfg, claims: vdmKernel.claims(cfg) }],
    });
    const card = machine.cards[0] as { display: { descriptor: { mode: string; cols: number; rows: number }; frame(): { bytes: Uint8Array } } };
    expect(card.display.descriptor).toMatchObject({ mode: 'charGrid', cols: 64, rows: 16 });

    let steps = 0;
    while (!machine.cpu.halted && steps < 200) { machine.cpu.step(); steps++; }

    const frame = card.display.frame();
    expect(frame.bytes.length).toBe(0x400);
    // "Hi" landed at the top-left of the character buffer.
    expect(frame.bytes[0]).toBe(0x48);
    expect(frame.bytes[1]).toBe(0x69);
  });

  it('a parallel card exposes a GPIO surface: latches CPU writes, presents host input', () => {
    const cfg = withDefaults(
      { name: 'x', version: '1.0.0', type: 'parallel', configSchema: parallelKernel.configSchema },
      { port: 0x40, direction: 'inout' },
    );
    const machine = buildMachine({
      cpuKind: 'i8080',
      clock: 'max',
      resetVector: 0,
      // MVI A,0xA5 ; OUT 0x40 ; IN 0x40 ; HLT
      memory: [
        { id: 'rom', base: 0, size: 6, kind: 'rom', image: new Uint8Array([0x3e, 0xa5, 0xd3, 0x40, 0xdb, 0x40]) },
      ],
      cards: [{ id: 'gpio', factory: parallelKernel.create, config: cfg, claims: parallelKernel.claims(cfg) }],
    });
    const card = machine.cards[0] as { gpio: { read(): number; setInput(b: number): void; onOutput(cb: (b: number) => void): void; direction: string } };
    const seen: number[] = [];
    card.gpio.onOutput((b) => seen.push(b));
    card.gpio.setInput(0x3c); // sense switches

    let steps = 0;
    while (!machine.cpu.halted && steps < 100) { machine.cpu.step(); steps++; }

    expect(card.gpio.direction).toBe('inout');
    expect(seen).toEqual([0xa5]); // OUT 0x40 latched the output + fired the callback
    expect(card.gpio.read()).toBe(0xa5); // the latched output byte (drive LEDs)
    expect(machine.cpu.registers.a).toBe(0x3c); // IN 0x40 read the host-driven input
  });
});
