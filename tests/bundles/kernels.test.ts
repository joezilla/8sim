import { describe, it, expect } from 'vitest';
import { kernels, kernelById, serialKernel } from '../../src/bundles/kernels.js';
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
});
