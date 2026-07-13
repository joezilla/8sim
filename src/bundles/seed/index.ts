import type { IS100Card } from '../../interfaces/IS100Card.js';
import type { IIODevice } from '../../interfaces/IIODevice.js';
import { ImsaiSioCard } from '../../cards/ImsaiSioCard.js';
import { Mits2SioCard } from '../../cards/Mits2SioCard.js';
import { ImsaiMioCard } from '../../cards/ImsaiMioCard.js';
import { MitsDcddCard } from '../../cards/MitsDcddCard.js';
import { ImsaiMdcDioCard } from '../../cards/ImsaiMdcDioCard.js';
import type { MdcDioDisk } from '../../cards/mdcdio/MdcDioDisk.js';
import { ImsaiFifCard } from '../../cards/ImsaiFifCard.js';
import type { FloppyDisk } from '../../cards/floppy/FloppyDisk.js';
import { ProcTech3pSCard } from '../../cards/ProcTech3pSCard.js';
import { PT_NATIVE_STATUS, SIO2_STATUS } from '../../cards/ProcTech3pS.js';
import { HeliosCard } from '../../cards/HeliosCard.js';
import type { HeliosDisk } from '../../cards/helios/HeliosDisk.js';
import { Usart8251 } from '../../cards/Usart8251.js';
import { Mc6850Acia } from '../../cards/Mc6850Acia.js';
import { Port8212 } from '../../cards/Port8212.js';
import { Tr1602Uart } from '../../cards/Tr1602Uart.js';
import { FdcPlusClient, type WebSocketLike } from '../../cards/FdcPlusClient.js';
import { FdcPlusFloppyDisk } from '../../cards/floppy/FdcPlusFloppyDisk.js';
import { FdcPlusHeliosDisk } from '../../cards/helios/FdcPlusHeliosDisk.js';
import type { CardBundle } from '../CardBundle.js';
import { MachineSpecError, type CardContext } from '../../machine/MachineSpec.js';

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

/**
 * The DMA floppy controllers (FIF, MDC-DIO, Helios) accept in-process disk
 * backends via a dedicated `*Disks` service. When the host injects none but
 * *does* wire an FDC transport channel (`services.fdc` — fdcplus-web's
 * per-instance disk channel, the same one the MITS 88-DCDD uses), back each
 * drive with a lazy transport disk over that channel so a server-mounted image
 * boots without in-process injection. Returns `undefined` when neither is
 * present, preserving the "controller reports not-ready until disks are set"
 * behavior. `make` adapts the shared {@link FdcPlusClient} to the controller's
 * disk type; `key` maps a drive index to the controller's disk-map key.
 */
function fdcTransportDisks<T>(
  ctx: CardContext,
  drives: number,
  make: (client: FdcPlusClient, drive: number) => T,
  key: (drive: number) => string = String,
): Record<string, T> | undefined {
  const ws = ctx.services.fdc as WebSocketLike | undefined;
  if (!ws) return undefined;
  const client = new FdcPlusClient(ws);
  const disks: Record<string, T> = {};
  for (let d = 0; d < drives; d++) disks[key(d)] = make(client, d);
  return disks;
}

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

export const imsaiMdcDioBundle: CardBundle = {
  manifest: {
    name: 'imsai-mdc-dio',
    version: '1.0.0',
    type: 'floppy',
    kind: 'card',
    maker: 'IMSAI',
    summary:
      'IMSAI MDC-DIO firmware-driven floppy controller; memory window E000-EFFF plus XE/XF enable ports.',
    configSchema: {
      ioPage: { type: 'u8', default: 0x0e, min: 0, max: 0x0f, description: 'I/O page nibble X (ports X-E / X-F)' },
      stdGeometry: { type: 'enum', default: 'std-sd', enum: ['std-sd', 'std-dd'], description: 'Standard-drive format' },
    },
  },
  // The E000-EFFF memory window is attached by the card itself in attach()
  // (like BankRamCard), so it is NOT declared as a memory region here — the
  // machine must keep RAM clear of E000-EFFF. Disks are injected via
  // ctx.services.mdcDioDisks (keyed "std:0", "mini:0", ...); absent it, fall
  // back to the FDC transport (ctx.services.fdc) for the standard drives.
  cardFactory: (id, cfg, ctx) => {
    const stdGeometry = cfg.stdGeometry === 'std-dd' ? 'std-dd' : 'std-sd';
    return new ImsaiMdcDioCard(id, {
      ioPage: u8(cfg.ioPage, 0x0e) & 0x0f,
      stdGeometry,
      disks:
        (ctx.services.mdcDioDisks as Record<string, MdcDioDisk> | undefined) ??
        fdcTransportDisks(
          ctx,
          4,
          (client, d) => new FdcPlusFloppyDisk(client, d, stdGeometry),
          (d) => `std:${d}`,
        ),
    });
  },
  claims: (cfg) => {
    const page = u8(cfg.ioPage, 0x0e) & 0x0f;
    return { ports: [(page << 4) | 0x0e, (page << 4) | 0x0f] };
  },
};

export const imsaiFifBundle: CardBundle = {
  manifest: {
    name: 'imsai-fif',
    version: '1.0.0',
    type: 'floppy',
    kind: 'card',
    maker: 'IMSAI',
    summary:
      'IMSAI FIF (IFM+FIB) Floppy Disk System — DMA-capable controller on a single output port (0xFD).',
    configSchema: {
      port: { type: 'u8', default: 0xfd, min: 0, max: 0xff, description: 'Command port (IMSAI standard 0xFD)' },
    },
  },
  // Disks injected via ctx.services.fifDisks (keyed "0".."3"); absent it, fall
  // back to the FDC transport (ctx.services.fdc). I/O-only card — no memory
  // region, so the machine keeps its full 64K RAM.
  cardFactory: (id, cfg, ctx) =>
    new ImsaiFifCard(id, {
      port: u8(cfg.port, 0xfd),
      disks:
        (ctx.services.fifDisks as Record<string, FloppyDisk> | undefined) ??
        fdcTransportDisks(ctx, 4, (client, d) => new FdcPlusFloppyDisk(client, d, 'std-sd')),
    }),
  claims: (cfg) => ({ ports: [u8(cfg.port, 0xfd)] }),
};

export const procTech3pSBundle: CardBundle = {
  manifest: {
    name: 'proctech-3ps',
    version: '1.0.0',
    type: 'serial',
    kind: 'card',
    maker: 'Processor Technology',
    summary: 'Processor Technology 3P+S: two parallel ports + control/status + UART serial, on 4 consecutive ports.',
    configSchema: {
      basePort: { type: 'u8', default: 0x00, min: 0, max: 0xfc, description: 'Group base (claims base..base+3)' },
      channelOrder: { type: 'enum', default: 'CDAB', enum: ['CDAB', 'ABCD'], description: 'CDAB=control/serial-low (PT default); ABCD=parallel-low' },
      statusPreset: { type: 'enum', default: 'pt-native', enum: ['pt-native', 'sio2'], description: 'Status-word bit layout (Area G)' },
      a0Invert: { type: 'enum', default: 'off', enum: ['off', 'on'], description: 'Invert A0 (IMSAI SIO-2 pair swap)' },
      configMode: { type: 'enum', default: 'static', enum: ['static', 'dynamic'], description: 'UART config: hardwired jumpers vs. control-word bits 4-7' },
    },
  },
  cardFactory: (id, cfg) =>
    new ProcTech3pSCard(id, {
      baseAddress: u8(cfg.basePort, 0x00),
      channelOrder: cfg.channelOrder === 'ABCD' ? 'ABCD' : 'CDAB',
      statusMap: cfg.statusPreset === 'sio2' ? SIO2_STATUS : PT_NATIVE_STATUS,
      a0Invert: cfg.a0Invert === 'on',
      configMode: cfg.configMode === 'dynamic' ? 'dynamic' : 'static',
    }),
  claims: (cfg) => { const b = u8(cfg.basePort, 0x00); return { ports: [b, b + 1, b + 2, b + 3] }; },
};

export const heliosBundle: CardBundle = {
  manifest: {
    name: 'pt-helios',
    version: '1.0.0',
    type: 'floppy',
    kind: 'card',
    maker: 'Processor Technology',
    summary: 'Processor Technology Helios II — intelligent DMA 8" disk controller (ports F0-F7); boots PTDOS via SOLOS BOOTLOAD.',
    configSchema: {
      basePort: { type: 'u8', default: 0xf0, min: 0, max: 0xf8, description: 'Base I/O port (claims base..base+7; Sol standard 0xF0)' },
    },
  },
  // Disks injected via ctx.services.heliosDisks (keyed "0".."7"); absent it,
  // fall back to the FDC transport (ctx.services.fdc). I/O-only card (8
  // consecutive ports).
  cardFactory: (id, cfg, ctx) =>
    new HeliosCard(id, {
      port: u8(cfg.basePort, 0xf0),
      disks:
        (ctx.services.heliosDisks as Record<string, HeliosDisk> | undefined) ??
        fdcTransportDisks(ctx, 8, (client, d) => new FdcPlusHeliosDisk(client, d)),
    }),
  claims: (cfg) => { const b = u8(cfg.basePort, 0xf0); return { ports: [b, b + 1, b + 2, b + 3, b + 4, b + 5, b + 6, b + 7] }; },
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
  imsaiMdcDioBundle,
  imsaiFifBundle,
  procTech3pSBundle,
  heliosBundle,
  usart8251Bundle,
  mc6850Bundle,
  port8212Bundle,
  tr1602Bundle,
  ramCardBundle,
  epromCardBundle,
];

export const seedBundleByName = (name: string): CardBundle | undefined =>
  seedBundles.find((b) => b.manifest.name === name);
