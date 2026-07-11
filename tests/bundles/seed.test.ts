import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildMachine } from '../../src/machine/buildMachine.js';
import { MachineSpecError } from '../../src/machine/MachineSpec.js';
import { withDefaults } from '../../src/bundles/CardBundle.js';
import { seedBundles, imsaiSioBundle, mitsDcddBundle } from '../../src/bundles/seed/index.js';
import type { WebSocketLike } from '../../src/cards/FdcPlusClient.js';

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
  });
});
