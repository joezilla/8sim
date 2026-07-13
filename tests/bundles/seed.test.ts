import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildMachine } from '../../src/machine/buildMachine.js';
import { MachineSpecError, type CardContext } from '../../src/machine/MachineSpec.js';
import { withDefaults, CardConfigError, type CardBundle } from '../../src/bundles/CardBundle.js';
import { seedBundles, imsaiSioBundle, imsaiMioBundle, mitsDcddBundle, imsaiMdcDioBundle, imsaiFifBundle } from '../../src/bundles/seed/index.js';
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

  it('memory cards (RAM/EPROM) declare regions, not I/O, and build into the memory map', () => {
    const ram = seedBundles.find((b) => b.manifest.name === 'ram-card')!;
    const eprom = seedBundles.find((b) => b.manifest.name === 'eprom-card')!;
    expect(ram.memory).toBeDefined();
    expect(eprom.memory).toBeDefined();
    expect(ram.claims({}).ports).toEqual([]); // no I/O footprint

    expect(ram.memory!(withDefaults(ram.manifest, { base: 0x0000, size: 0x4000 }))).toEqual([
      { id: 'ram', base: 0, size: 0x4000, kind: 'ram' },
    ]);

    const rom = eprom.memory!(withDefaults(eprom.manifest, { base: 0xf800, size: 0x0800 }));
    expect(rom[0]).toMatchObject({ id: 'rom', base: 0xf800, size: 0x0800, kind: 'rom' });
    expect(rom[0].image!.length).toBe(0x0800); // rom size === image length

    // Hoisted into spec.memory, RAM + EPROM regions build a valid machine.
    const m = buildMachine({
      cpuKind: 'i8080',
      clock: 'max',
      resetVector: 0,
      memory: [
        ...ram.memory!(withDefaults(ram.manifest, { base: 0x0000, size: 0x8000 })),
        ...eprom.memory!(withDefaults(eprom.manifest, { base: 0xf800, size: 0x0100 })),
      ],
      cards: [],
    });
    expect(m.cpu).toBeDefined();
  });

  it('CPU cards declare the processor (not I/O), carrying the power-on jump (Story 5.1)', () => {
    const i8080 = seedBundles.find((b) => b.manifest.name === 'i8080-cpu')!;
    const z80 = seedBundles.find((b) => b.manifest.name === 'z80-cpu')!;
    expect(i8080.cpu).toBeDefined();
    expect(z80.cpu).toBeDefined();
    expect(i8080.claims({}).ports).toEqual([]); // no bus I/O footprint
    expect(i8080.manifest.type).toBe('cpu');

    expect(i8080.cpu!(withDefaults(i8080.manifest, { resetVector: 0xff00 }))).toEqual({
      kind: 'i8080',
      resetVector: 0xff00,
    });
    expect(z80.cpu!(withDefaults(z80.manifest, {})).kind).toBe('z80');

    // A machine built with the CPU the card resolves to (Z80) runs.
    const m = buildMachine({
      cpuKind: z80.cpu!(withDefaults(z80.manifest, {})).kind,
      clock: 'max',
      resetVector: 0,
      memory: [{ id: 'ram', base: 0, size: 0x10000, kind: 'ram' }],
      cards: [],
    });
    expect(m.cpu).toBeDefined();
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

  it('the IMSAI MDC-DIO bundle claims only its XE/XF ports and serves its window', () => {
    expect(imsaiMdcDioBundle.manifest.type).toBe('floppy');
    expect(imsaiMdcDioBundle.manifest.kind).toBe('card');
    const cfg = withDefaults(imsaiMdcDioBundle.manifest); // ioPage default 0xE
    expect(imsaiMdcDioBundle.claims(cfg).ports).toEqual([0xee, 0xef]);
    // No `memory` fn — the window is card-attached, not hoisted into spec.memory.
    expect(imsaiMdcDioBundle.memory).toBeUndefined();

    // The factory builds a card that serves its firmware ROM at E000.
    const ctx: CardContext = { pic: new InterruptController(), log: () => {}, services: {} };
    const card = imsaiMdcDioBundle.cardFactory('mdc', cfg, ctx);
    let windowBase = -1;
    const probeBus = {
      attachMemory: (m: { baseAddress: number; read(o: number): number }) => {
        windowBase = m.baseAddress;
        expect(m.read(0)).toBe(0xc3); // stub ROM JMP vector
      },
      attachIODevice: () => {},
    } as unknown as Bus;
    card.attach(probeBus);
    expect(windowBase).toBe(0xe000);
  });

  it('the IMSAI FIF bundle is an I/O-only floppy card claiming just port 0xFD', () => {
    expect(imsaiFifBundle.manifest.type).toBe('floppy');
    expect(imsaiFifBundle.manifest.kind).toBe('card');
    const cfg = withDefaults(imsaiFifBundle.manifest); // port default 0xFD
    expect(imsaiFifBundle.claims(cfg).ports).toEqual([0xfd]);
    expect(imsaiFifBundle.memory).toBeUndefined(); // no memory region — full 64K RAM stays free
    // Builds on a full-RAM machine (no memory conflict since it's I/O-only).
    const m = buildMachine({
      cpuKind: 'i8080',
      clock: 'max',
      resetVector: 0,
      memory: [{ id: 'ram', base: 0, size: 0x10000, kind: 'ram' }],
      cards: [{ id: 'fif', factory: imsaiFifBundle.cardFactory, config: cfg, claims: imsaiFifBundle.claims(cfg) }],
    });
    expect(m.cards).toHaveLength(1);
  });

  it('the Processor Technology 3P+S bundle claims 4 consecutive ports', () => {
    const b = seedBundles.find((x) => x.manifest.name === 'proctech-3ps')!;
    expect(b.manifest.type).toBe('serial');
    expect(b.manifest.kind).toBe('card');
    const cfg = withDefaults(b.manifest, { basePort: 0x10 });
    expect(b.claims(cfg).ports).toEqual([0x10, 0x11, 0x12, 0x13]);
    expect(b.memory).toBeUndefined(); // I/O-only card
    // factory builds and registers exactly those 4 ports
    const ctx: CardContext = { pic: new InterruptController(), log: () => {}, services: {} };
    const ports: number[] = [];
    const probeBus = { attachIODevice: (d: IIODevice) => ports.push(...d.basePorts), attachMemory: () => {} } as unknown as Bus;
    b.cardFactory('3ps', cfg, ctx).attach(probeBus);
    expect(ports.sort((x, y) => x - y)).toEqual([0x10, 0x11, 0x12, 0x13]);
  });

  it('the Helios II bundle claims 8 consecutive ports F0-F7', () => {
    const b = seedBundles.find((x) => x.manifest.name === 'pt-helios')!;
    expect(b.manifest.type).toBe('floppy');
    expect(b.manifest.maker).toBe('Processor Technology');
    const cfg = withDefaults(b.manifest); // basePort default 0xF0
    expect(b.claims(cfg).ports).toEqual([0xf0, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7]);
    const ctx: CardContext = { pic: new InterruptController(), log: () => {}, services: {} };
    expect(() => b.cardFactory('helios', cfg, ctx)).not.toThrow();
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

  it('the IMSAI FIF boots its disk over the FDC transport when no in-process disks are injected', async () => {
    // Regression: the FIF card sources disks from ctx.services.fifDisks; when a
    // host wires only the FDC transport (services.fdc — fdcplus-web's per-instance
    // channel), the bundle must fall back to it, or the MPU-A monitor's boot-sector
    // DMA reads nothing, fails its 'DI' signature check, and drops to the "?" loop.
    const romPath = join(import.meta.dirname ?? '', '../../bios/imsai-mpu-a-rom.bin');
    if (!existsSync(romPath)) {
      console.warn(`IMSAI MPU-A boot ROM not found at ${romPath}; skipping.`);
      return;
    }
    const rom = new Uint8Array(readFileSync(romPath));
    const romTop = 0xd800 + rom.length;

    const sent: Uint8Array[] = [];
    const fakeWs: WebSocketLike = {
      send: (d: Uint8Array) => void sent.push(d instanceof Uint8Array ? d : new Uint8Array(d)),
      close: () => {},
      onmessage: null,
      onclose: null,
      onerror: null,
      readyState: 1,
    };

    const sioCfg = withDefaults(imsaiSioBundle.manifest, { basePortA: 0x02, basePortB: 0x04, boardCtrlPort: 0x08 });
    const fifCfg = withDefaults(imsaiFifBundle.manifest);

    const machine = buildMachine(
      {
        cpuKind: 'i8080',
        clock: 'max',
        resetVector: 0xd800,
        memory: [
          { id: 'lo', base: 0x0000, size: 0xd800, kind: 'ram' },
          { id: 'mpu-a', base: 0xd800, size: rom.length, kind: 'rom', image: rom },
          { id: 'hi', base: romTop, size: 0x10000 - romTop, kind: 'ram' },
        ],
        cards: [
          { id: 'sio', factory: imsaiSioBundle.cardFactory, config: sioCfg, claims: imsaiSioBundle.claims(sioCfg) },
          { id: 'fif', factory: imsaiFifBundle.cardFactory, config: fifCfg, claims: imsaiFifBundle.claims(fifCfg) },
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
    // The FIF issued a track op to the transport — the boot read reached the disk.
    expect(sent.length).toBeGreaterThan(0);
    const cmd = sent[0]!.length >= 4 ? String.fromCharCode(sent[0]![0]!, sent[0]![1]!, sent[0]![2]!, sent[0]![3]!) : '?';
    expect(['STAT', 'READ', 'WRIT']).toContain(cmd);
  });
});
