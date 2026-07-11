import { describe, it, expect } from 'vitest';
import { buildMachine } from '../../src/machine/buildMachine.js';
import { MachineSpecError, type MachineSpec, type CardFactory } from '../../src/machine/MachineSpec.js';
import type { IS100Card } from '../../src/interfaces/IS100Card.js';
import type { Bus } from '../../src/bus/Bus.js';

/** A minimal probe card that records the order in which cards are attached. */
function probeFactory(order: string[]): CardFactory {
  return (id): IS100Card => ({
    id,
    reset() {},
    attach(_bus: Bus) {
      order.push(id);
    },
  });
}

const RAM_FULL = { id: 'ram', base: 0x0000, size: 0x10000, kind: 'ram' as const };

describe('buildMachine — construction', () => {
  it('builds an 8080 machine and sets PC to the resetVector', () => {
    const spec: MachineSpec = {
      cpuKind: 'i8080',
      clock: { hz: 2_000_000 },
      resetVector: 0x0100,
      memory: [RAM_FULL],
      cards: [],
    };
    const m = buildMachine(spec);
    expect(m.cpu.pc).toBe(0x0100);
    expect(m.cpu.halted).toBe(false);
    expect(m.runner.targetHz).toBe(2_000_000);
    expect(m.spec).toBe(spec);
  });

  it('builds a z80 machine from the same shape', () => {
    const m = buildMachine({
      cpuKind: 'z80',
      clock: 'max',
      resetVector: 0x0000,
      memory: [RAM_FULL],
      cards: [],
    });
    expect(m.cpu.pc).toBe(0x0000);
    expect(m.runner.targetHz).toBe('max');
  });

  it('makes ROM contents readable on the bus at the region base', () => {
    const image = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    const m = buildMachine({
      cpuKind: 'i8080',
      clock: 'max',
      resetVector: 0xff00,
      memory: [
        { id: 'ram', base: 0x0000, size: 0xff00, kind: 'ram' },
        { id: 'rom', base: 0xff00, size: 4, kind: 'rom', image },
      ],
      cards: [],
    });
    expect(m.bus.read(0xff00)).toBe(0xde);
    expect(m.bus.read(0xff03)).toBe(0xef);
    // ROM is read-only.
    m.bus.write(0xff00, 0x00);
    expect(m.bus.read(0xff00)).toBe(0xde);
  });

  it('attaches cards in slot order, after memory, before running', () => {
    const order: string[] = [];
    const m = buildMachine({
      cpuKind: 'i8080',
      clock: 'max',
      resetVector: 0x0000,
      memory: [RAM_FULL],
      cards: [
        { id: 'first', factory: probeFactory(order) },
        { id: 'second', factory: probeFactory(order) },
        { id: 'third', factory: probeFactory(order) },
      ],
    });
    expect(order).toEqual(['first', 'second', 'third']);
    expect(m.cards.map((c) => c.id)).toEqual(['first', 'second', 'third']);
  });

  it('passes a CardContext (pic + injected services) to each factory', () => {
    let seen: unknown;
    const m = buildMachine(
      {
        cpuKind: 'i8080',
        clock: 'max',
        resetVector: 0,
        memory: [RAM_FULL],
        cards: [
          {
            id: 'c',
            factory: (id, _cfg, ctx): IS100Card => {
              seen = ctx;
              return { id, reset() {}, attach() {} };
            },
          },
        ],
      },
      { services: { fdc: 'CHANNEL' } },
    );
    expect((seen as { pic: unknown }).pic).toBe(m.pic);
    expect((seen as { services: Record<string, unknown> }).services.fdc).toBe('CHANNEL');
  });
});

describe('buildMachine — validation rejects incoherent specs', () => {
  const base = (over: Partial<MachineSpec>): MachineSpec => ({
    cpuKind: 'i8080',
    clock: 'max',
    resetVector: 0x0000,
    memory: [RAM_FULL],
    cards: [],
    ...over,
  });

  it('rejects an unknown cpuKind', () => {
    expect(() => buildMachine(base({ cpuKind: 'i8085' as never }))).toThrow(MachineSpecError);
  });

  it('rejects a resetVector outside 0x0000..0xFFFF', () => {
    expect(() => buildMachine(base({ resetVector: 0x10000 }))).toThrow(/resetVector/);
  });

  it('rejects an invalid clock', () => {
    expect(() => buildMachine(base({ clock: { hz: 0 } }))).toThrow(/clock/);
  });

  it('rejects overlapping memory regions and names both', () => {
    expect(() =>
      buildMachine(
        base({
          memory: [
            { id: 'a', base: 0x0000, size: 0x2000, kind: 'ram' },
            { id: 'b', base: 0x1000, size: 0x2000, kind: 'ram' },
          ],
        }),
      ),
    ).toThrow(/overlap.*"a".*"b"/s);
  });

  it('rejects a rom whose image length != size', () => {
    expect(() =>
      buildMachine(base({ memory: [{ id: 'r', base: 0, size: 8, kind: 'rom', image: new Uint8Array(4) }] })),
    ).toThrow(/rom requires an image/);
  });

  it('rejects the mmio region kind (cards provide MMIO)', () => {
    expect(() => buildMachine(base({ memory: [{ id: 'm', base: 0, size: 16, kind: 'mmio' }] }))).toThrow(/mmio/);
  });

  it('rejects duplicate I/O port claims across cards', () => {
    const noop: CardFactory = (id) => ({ id, reset() {}, attach() {} });
    expect(() =>
      buildMachine(
        base({
          cards: [
            { id: 'sioA', factory: noop, claims: { ports: [0x10, 0x11] } },
            { id: 'sioB', factory: noop, claims: { ports: [0x10] } },
          ],
        }),
      ),
    ).toThrow(/port 0x10 claimed by both "sioA" and "sioB"/);
  });

  it('rejects duplicate IRQ claims across cards', () => {
    const noop: CardFactory = (id) => ({ id, reset() {}, attach() {} });
    expect(() =>
      buildMachine(
        base({
          cards: [
            { id: 'x', factory: noop, claims: { irq: 3 } },
            { id: 'y', factory: noop, claims: { irq: 3 } },
          ],
        }),
      ),
    ).toThrow(/IRQ line 3 claimed by both "x" and "y"/);
  });
});
