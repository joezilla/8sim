import type { IS100Card } from '../../interfaces/IS100Card.js';
import type { IIODevice } from '../../interfaces/IIODevice.js';
import { ImsaiSioCard } from '../../cards/ImsaiSioCard.js';
import { Mits2SioCard } from '../../cards/Mits2SioCard.js';
import { ImsaiMioCard } from '../../cards/ImsaiMioCard.js';
import { MitsDcddCard } from '../../cards/MitsDcddCard.js';
import { Usart8251 } from '../../cards/Usart8251.js';
import { Mc6850Acia } from '../../cards/Mc6850Acia.js';
import { Port8212 } from '../../cards/Port8212.js';
import { Tr1602Uart } from '../../cards/Tr1602Uart.js';
import type { WebSocketLike } from '../../cards/FdcPlusClient.js';
import type { CardBundle } from '../CardBundle.js';
import { MachineSpecError } from '../../machine/MachineSpec.js';

/**
 * Seed Card Bundles (Story 1.2 / FR-4): the built-in 8sim cards packaged as
 * self-contained bundles with a uniform `cardFactory(id, config, ctx)` and an
 * in-bundle adapter to the underlying class (AR-5). fdcplus-web's Catalog
 * registers these on startup.
 */

const u8 = (v: unknown, fallback: number): number =>
  typeof v === 'number' ? v & 0xff : fallback;

const u16 = (v: unknown, fallback: number): number =>
  typeof v === 'number' ? v & 0xffff : fallback;

/** Wrap a bare IIODevice as an IS100Card (attach → attachIODevice). */
const deviceCard = (id: string, dev: IIODevice): IS100Card => ({
  id,
  reset: () => dev.reset(),
  attach: (bus) => bus.attachIODevice(dev),
});

/** A memory card contributes no I/O device — its region is hoisted into the
 * machine's memory map and attached there, so the card itself is a no-op on the bus. */
const memoryCard = (id: string): IS100Card => ({
  id,
  reset: () => {},
  attach: () => {},
});

/** A CPU card is the bus master, not a bus device — buildMachine instantiates the
 * processor from the resolved MachineSpec.cpuKind. On the bus the card is a no-op;
 * its real output is the `cpu()` resolution. (Its front-panel control lines, which
 * bypass the S-100 bus, are a future concern — not modeled here.) */
const cpuCard = (id: string): IS100Card => ({
  id,
  reset: () => {},
  attach: () => {},
});

export const mits2SioBundle: CardBundle = {
  manifest: {
    name: 'mits-88-2sio',
    version: '1.0.0',
    type: 'serial',
    kind: 'card',
    maker: 'MITS',
    summary: 'MITS 88-2SIO dual serial interface (2× 6850 ACIA).',
    configSchema: { basePort: { type: 'u8', default: 0x10, min: 0, max: 0xfc, description: 'Base I/O port (claims base..base+3)' } },
  },
  cardFactory: (id, cfg) => new Mits2SioCard(id, { basePort: u8(cfg.basePort, 0x10) }),
  claims: (cfg) => { const b = u8(cfg.basePort, 0x10); return { ports: [b, b + 1, b + 2, b + 3] }; },
};

export const imsaiSioBundle: CardBundle = {
  manifest: {
    name: 'imsai-sio2',
    version: '1.0.0',
    type: 'serial',
    kind: 'card',
    maker: 'IMSAI',
    summary: 'IMSAI SIO-2 dual 8251 serial card with a board-control port.',
    configSchema: {
      basePortA: { type: 'u8', default: 0x02, min: 0, max: 0xfe },
      basePortB: { type: 'u8', default: 0x04, min: 0, max: 0xfe },
      boardCtrlPort: { type: 'u8', default: 0x08, min: 0, max: 0xff },
    },
  },
  cardFactory: (id, cfg) =>
    new ImsaiSioCard(id, {
      basePortA: u8(cfg.basePortA, 0x02),
      basePortB: u8(cfg.basePortB, 0x04),
      boardCtrlPort: u8(cfg.boardCtrlPort, 0x08),
    }),
  claims: (cfg) => {
    const a = u8(cfg.basePortA, 0x02);
    const b = u8(cfg.basePortB, 0x04);
    const c = u8(cfg.boardCtrlPort, 0x08);
    return { ports: [a, a + 1, b, b + 1, c] };
  },
};

export const imsaiMioBundle: CardBundle = {
  manifest: {
    name: 'imsai-mio',
    version: '1.0.0',
    type: 'serial',
    kind: 'card',
    maker: 'IMSAI',
    summary: 'IMSAI MIO multi-I/O card: two 8212 parallel ports (base+0/+1) and a TR1602 UART (base+2/+3).',
    configSchema: { basePort: { type: 'u8', default: 0x10, min: 0, max: 0xfc } },
  },
  cardFactory: (id, cfg) => new ImsaiMioCard(id, { basePort: u8(cfg.basePort, 0x10) }),
  // Registers 4 consecutive ports: portA(base), portB(base+1), UART(base+2/+3).
  claims: (cfg) => { const b = u8(cfg.basePort, 0x10); return { ports: [b, b + 1, b + 2, b + 3] }; },
};

export const mitsDcddBundle: CardBundle = {
  manifest: {
    name: 'mits-88-dcdd',
    version: '1.0.0',
    type: 'floppy',
    kind: 'card',
    maker: 'MITS',
    summary: 'MITS 88-DCDD 8-inch floppy controller; disk I/O over the FDC channel.',
    configSchema: { basePort: { type: 'u8', default: 0x08, min: 0, max: 0xfd } },
  },
  cardFactory: (id, cfg, ctx) => {
    const ws = ctx.services.fdc as WebSocketLike | undefined;
    if (!ws) {
      throw new MachineSpecError(
        `card "${id}" (mits-88-dcdd) requires an FDC channel in ctx.services.fdc`,
      );
    }
    return new MitsDcddCard(id, ws, { basePort: u8(cfg.basePort, 0x08) });
  },
  claims: (cfg) => { const b = u8(cfg.basePort, 0x08); return { ports: [b, b + 1, b + 2] }; },
};

export const usart8251Bundle: CardBundle = {
  manifest: {
    name: 'intel-8251',
    version: '1.0.0',
    type: 'serial',
    kind: 'chip',
    maker: 'Intel',
    summary: 'Intel 8251 USART (data + control port).',
    configSchema: {
      dataPort: { type: 'u8', default: 0x10, min: 0, max: 0xff },
      ctrlPort: { type: 'u8', default: 0x11, min: 0, max: 0xff },
    },
  },
  cardFactory: (id, cfg) =>
    deviceCard(id, new Usart8251(id, u8(cfg.dataPort, 0x10), u8(cfg.ctrlPort, 0x11))),
  claims: (cfg) => ({ ports: [u8(cfg.dataPort, 0x10), u8(cfg.ctrlPort, 0x11)] }),
};

export const mc6850Bundle: CardBundle = {
  manifest: {
    name: 'motorola-6850',
    version: '1.0.0',
    type: 'serial',
    kind: 'chip',
    maker: 'Motorola',
    summary: 'Motorola 6850 ACIA (status + data port).',
    configSchema: {
      statusPort: { type: 'u8', default: 0x10, min: 0, max: 0xff },
      dataPort: { type: 'u8', default: 0x11, min: 0, max: 0xff },
    },
  },
  cardFactory: (id, cfg) =>
    deviceCard(id, new Mc6850Acia(id, u8(cfg.statusPort, 0x10), u8(cfg.dataPort, 0x11))),
  claims: (cfg) => ({ ports: [u8(cfg.statusPort, 0x10), u8(cfg.dataPort, 0x11)] }),
};

export const port8212Bundle: CardBundle = {
  manifest: {
    name: 'intel-8212',
    version: '1.0.0',
    type: 'other',
    kind: 'chip',
    maker: 'Intel',
    summary: 'Intel 8212 8-bit I/O port.',
    configSchema: { port: { type: 'u8', default: 0xff, min: 0, max: 0xff } },
  },
  cardFactory: (id, cfg) => deviceCard(id, new Port8212(id, u8(cfg.port, 0xff))),
  claims: (cfg) => ({ ports: [u8(cfg.port, 0xff)] }),
};

export const tr1602Bundle: CardBundle = {
  manifest: {
    name: 'tr1602-uart',
    version: '1.0.0',
    type: 'serial',
    kind: 'chip',
    maker: 'Western Digital',
    summary: 'TR1602 UART (data + status port).',
    configSchema: {
      dataPort: { type: 'u8', default: 0x00, min: 0, max: 0xff },
      statusPort: { type: 'u8', default: 0x01, min: 0, max: 0xff },
    },
  },
  cardFactory: (id, cfg) =>
    deviceCard(id, new Tr1602Uart(id, u8(cfg.dataPort, 0x00), u8(cfg.statusPort, 0x01))),
  claims: (cfg) => ({ ports: [u8(cfg.dataPort, 0x00), u8(cfg.statusPort, 0x01)] }),
};

/** Static RAM card — maps RAM at a base address for a size. A memory card:
 * contributes no I/O device, only a RAM region hoisted into the memory map. */
export const ramCardBundle: CardBundle = {
  manifest: {
    name: 'ram-card',
    version: '1.0.0',
    type: 'memory',
    kind: 'card',
    maker: 'generic',
    summary: 'Static RAM board — maps read/write RAM at a configurable base address.',
    configSchema: {
      base: { type: 'u16', default: 0x0000, min: 0, max: 0xffff, description: 'Start address' },
      size: { type: 'u16', default: 0x4000, min: 1, max: 0xffff, description: 'Bytes of RAM' },
    },
  },
  cardFactory: (id) => memoryCard(id),
  claims: () => ({ ports: [] }),
  memory: (cfg) => [{ id: 'ram', base: u16(cfg.base, 0x0000), size: u16(cfg.size, 0x4000), kind: 'ram' }],
};

/** EPROM card — maps a ROM at a base address. The chip ships empty (zero-filled);
 * an image is burned in later. A memory card: no I/O, just a ROM region. */
export const epromCardBundle: CardBundle = {
  manifest: {
    name: 'eprom-card',
    version: '1.0.0',
    type: 'memory',
    kind: 'card',
    maker: 'generic',
    summary: 'EPROM board — maps a read-only region at a base address; burn a .bin/Intel-HEX image into it.',
    configSchema: {
      base: { type: 'u16', default: 0xf000, min: 0, max: 0xffff, description: 'Start address' },
      size: { type: 'u16', default: 0x0800, min: 1, max: 0xffff, description: 'EPROM size in bytes' },
    },
  },
  cardFactory: (id) => memoryCard(id),
  claims: () => ({ ports: [] }),
  memory: (cfg) => {
    const base = u16(cfg.base, 0xf000);
    const size = u16(cfg.size, 0x0800);
    return [{ id: 'rom', base, size, kind: 'rom', image: new Uint8Array(size) }];
  },
};

/** Intel 8080 CPU card — the processor board. Declares the CPU family and the
 * power-on jump (resetVector), authentically a CPU-card feature. No bus I/O. */
export const i8080CpuBundle: CardBundle = {
  manifest: {
    name: 'i8080-cpu',
    version: '1.0.0',
    type: 'cpu',
    kind: 'card',
    maker: 'Intel',
    summary: 'Intel 8080 CPU board — the bus master; sets the power-on jump address.',
    configSchema: {
      resetVector: { type: 'u16', default: 0x0000, min: 0, max: 0xffff, description: 'Power-on jump (program counter at reset)' },
    },
  },
  cardFactory: (id) => cpuCard(id),
  claims: () => ({ ports: [] }),
  cpu: (cfg) => ({ kind: 'i8080', resetVector: u16(cfg.resetVector, 0x0000) }),
};

/** Zilog Z80 CPU card — 8080-compatible bus master with the Z80 instruction set. */
export const z80CpuBundle: CardBundle = {
  manifest: {
    name: 'z80-cpu',
    version: '1.0.0',
    type: 'cpu',
    kind: 'card',
    maker: 'Zilog',
    summary: 'Zilog Z80 CPU board — the bus master; sets the power-on jump address.',
    configSchema: {
      resetVector: { type: 'u16', default: 0x0000, min: 0, max: 0xffff, description: 'Power-on jump (program counter at reset)' },
    },
  },
  cardFactory: (id) => cpuCard(id),
  claims: () => ({ ports: [] }),
  cpu: (cfg) => ({ kind: 'z80', resetVector: u16(cfg.resetVector, 0x0000) }),
};

/** All built-in seed bundles, keyed by manifest name. */
export const seedBundles: ReadonlyArray<CardBundle> = [
  i8080CpuBundle,
  z80CpuBundle,
  mits2SioBundle,
  imsaiSioBundle,
  imsaiMioBundle,
  mitsDcddBundle,
  usart8251Bundle,
  mc6850Bundle,
  port8212Bundle,
  tr1602Bundle,
  ramCardBundle,
  epromCardBundle,
];

export const seedBundleByName = (name: string): CardBundle | undefined =>
  seedBundles.find((b) => b.manifest.name === name);
