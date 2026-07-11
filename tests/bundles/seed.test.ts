import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildMachine } from '../../src/machine/buildMachine.js';
import { MachineSpecError, type CardContext } from '../../src/machine/MachineSpec.js';
import { withDefaults, CardConfigError, type CardBundle } from '../../src/bundles/CardBundle.js';
import { seedBundles, imsaiSioBundle, imsaiMioBundle, mitsDcddBundle } from '../../src/bundles/seed/index.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import type { Bus } from '../../src/bus/Bus.js';
import type { IIODevice } from '../../src/interfaces/IIODevice.js';
import type { WebSocketLike } from '../../src/cards/FdcPlusClient.js';

const stubWs: WebSocketLike = {
  send: () => {},
  close: () => {},
  onmessage: null,
  onclose: null,
  onerror: null,
  readyState: 1,
};

/** Build a card and capture the I/O ports it actually registers on the bus. */
function registeredPorts(bundle: CardBundle, cfg: Record<string, unknown>): number[] {
  const ports: number[] = [];
  const probeBus = {
    attachIODevice: (d: IIODevice) => ports.push(...d.basePorts.map((p) => p & 0xff)),
    attachMemory: () => {},
  } as unknown as Bus;
  const ctx: CardContext = { pic: new InterruptController(), log: () => {}, services: { fdc: stubWs } };
  const card = bundle.cardFactory('probe', cfg, ctx);
  card.attach(probeBus);
  return ports;
}

describe('seed card bundles', () => {
  it('exposes a registry of well-formed bundles with unique Identity', () => {
    expect(seedBundles.length).toBeGreaterThanOrEqual(8);
    const names = new Set<string>();
    for (const b of seedBundles) {
      expect(b.manifest.name).toBeTruthy();
      expect(b.manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof b.cardFactory).toBe('function');
      expect(typeof b.claims).toBe('function');
      expect(Object.keys(b.manifest.configSchema).length).toBeGreaterThan(0);
      expect(names.has(b.manifest.name)).toBe(false);
      names.add(b.manifest.name);
    }
  });

  it('classifies each bundle as a card (S-100 board) or chip (component)', () => {
    const kindOf = (name: string) =>
      seedBundles.find((b) => b.manifest.name === name)!.manifest.kind;
    // Real S-100 boards.
    for (const n of ['mits-88-2sio', 'imsai-sio2', 'imsai-mio', 'mits-88-dcdd']) {
      expect(kindOf(n), n).toBe('card');
    }
    // Bare component chips (deviceCard-wrapped) — the parts those cards are built from.
    for (const n of ['intel-8251', 'motorola-6850', 'intel-8212', 'tr1602-uart']) {
      expect(kindOf(n), n).toBe('chip');
    }
    // Every bundle is classified.
    for (const b of seedBundles) {
      expect(['card', 'chip'], b.manifest.name).toContain(b.manifest.kind);
    }
  });

  it('derives collision-valid claims from schema defaults', () => {
    for (const b of seedBundles) {
      const cfg = withDefaults(b.manifest);
      const claims = b.claims(cfg);
      // buildMachine accepts a single seed card installed on a full-RAM machine.
      if (b.manifest.name === 'mits-88-dcdd') continue; // needs an FDC channel
      const m = buildMachine({
        cpuKind: 'i8080',
        clock: 'max',
        resetVector: 0,
        memory: [{ id: 'ram', base: 0, size: 0x10000, kind: 'ram' }],
        cards: [{ id: b.manifest.name, factory: b.cardFactory, config: cfg, claims }],
      });
      expect(m.cards).toHaveLength(1);
    }
  });

  it('declares claims that exactly match the ports each card registers', () => {
    // Regression guard: a bundle's hand-written claims must equal the ports its
    // card actually registers on the bus, or a real collision slips past
    // buildMachine's validation (which sees only claims).
    for (const b of seedBundles) {
      const cfg = withDefaults(b.manifest);
      const declared = [...new Set((b.claims(cfg).ports ?? []).map((p) => p & 0xff))].sort((x, y) => x - y);
      const actual = [...new Set(registeredPorts(b, cfg))].sort((x, y) => x - y);
      expect(actual, `claims mismatch for "${b.manifest.name}"`).toEqual(declared);
    }
  });

  it('rejects config values outside the schema bounds', () => {
    expect(() => withDefaults(imsaiMioBundle.manifest, { basePort: 0x1ff })).toThrow(CardConfigError);
    expect(() => withDefaults(imsaiMioBundle.manifest, { basePort: -1 })).toThrow(CardConfigError);
    expect(() => withDefaults(imsaiMioBundle.manifest, { basePort: 1.5 })).toThrow(CardConfigError);
  });

  it('rejects two seed serial cards that claim the same base port', () => {
    const cfg = withDefaults(imsaiSioBundle.manifest, { basePortA: 0x10 });
    expect(() =>
      buildMachine({
        cpuKind: 'i8080',
        clock: 'max',
        resetVector: 0,
        memory: [{ id: 'ram', base: 0, size: 0x10000, kind: 'ram' }],
        cards: [
          { id: 'a', factory: imsaiSioBundle.cardFactory, config: cfg, claims: imsaiSioBundle.claims(cfg) },
          { id: 'b', factory: imsaiSioBundle.cardFactory, config: cfg, claims: imsaiSioBundle.claims(cfg) },
        ],
      }),
    ).toThrow(MachineSpecError);
  });

  it('assembles the CDBL machine from seed bundles and reaches its first FDC command', async () => {
    const romPath = join(import.meta.dirname ?? '', '../../bios/cdbl-bootloader.bin');
    if (!existsSync(romPath)) {
      console.warn(`CDBL boot ROM not found at ${romPath}; skipping.`);
      return;
    }
    const rom = new Uint8Array(readFileSync(romPath));

    const sent: Uint8Array[] = [];
    const fakeWs: WebSocketLike = {
      send: (d: Uint8Array) => void sent.push(d instanceof Uint8Array ? d : new Uint8Array(d)),
      close: () => {},
      onmessage: null,
      onclose: null,
      onerror: null,
      readyState: 1,
    };

    const sioCfg = withDefaults(imsaiSioBundle.manifest, { basePortA: 0x12, boardCtrlPort: 0x18 });
    const dcddCfg = withDefaults(mitsDcddBundle.manifest);

    const machine = buildMachine(
      {
        cpuKind: 'i8080',
        clock: 'max',
        resetVector: 0xff00,
        memory: [
          { id: 'ram', base: 0x0000, size: 0xff00, kind: 'ram' },
          { id: 'cdbl', base: 0xff00, size: rom.length, kind: 'rom', image: rom },
        ],
        cards: [
          { id: 'sio', factory: imsaiSioBundle.cardFactory, config: sioCfg, claims: imsaiSioBundle.claims(sioCfg) },
          { id: 'dcdd', factory: mitsDcddBundle.cardFactory, config: dcddCfg, claims: mitsDcddBundle.claims(dcddCfg) },
        ],
      },
      { services: { fdc: fakeWs } },
    );

    const flush = () => new Promise((r) => setTimeout(r, 0));
    let steps = 0;
    while (steps < 5_000_000 && sent.length === 0 && !machine.cpu.halted) {
      for (let i = 0; i < 5000 && !machine.cpu.halted; i++) {
        machine.cpu.step();
        steps++;
      }
      await flush();
    }
    expect(sent.length).toBeGreaterThan(0);
    const cmd = sent[0]!.length >= 4 ? String.fromCharCode(sent[0]![0]!, sent[0]![1]!, sent[0]![2]!, sent[0]![3]!) : '?';
    expect(['STAT', 'READ', 'WRIT']).toContain(cmd);
  });
});
