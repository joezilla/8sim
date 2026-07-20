import type { CardFactory, MemoryRegionSpec } from '../machine/MachineSpec.js';
import type { ConfigParamSpec, ClaimsFn } from './CardBundle.js';
import { SerialCard, type SerialChip } from '../cards/SerialCard.js';
import { ParallelCard, type PortDirection } from '../cards/ParallelCard.js';
import { KeyboardCard } from '../cards/KeyboardCard.js';
import { VdmCard } from '../cards/VdmCard.js';
import { DazzlerCard } from '../cards/DazzlerCard.js';
import { RtcCard, type RtcClock } from '../cards/RtcCard.js';
import { BankRamCard } from '../cards/BankRamCard.js';
import { BootRomCard } from '../cards/BootRomCard.js';

const u8 = (v: unknown, fallback: number): number => (typeof v === 'number' ? v & 0xff : fallback);
const u16 = (v: unknown, fallback: number): number => (typeof v === 'number' ? v & 0xffff : fallback);

/**
 * Card behavior kernels (Bitsby8 Story 5.7).
 *
 * A kernel is a trusted, parameterized device state machine the host can build
 * an authored I/O card from — WITHOUT any user code. The host (fdcplus-web)
 * references a kernel by `id` in an authored card's declarative behavior, and
 * synthesizes a bundle from `create` + `claims`, exposing `configSchema` to its
 * settings UI. `binding` names the peripheral endpoint the card's far side
 * attaches to. This is the "behavior-kernel library" from the card taxonomy.
 */
export interface CardKernel {
  /** Kernel id referenced by an authored card's `behavior.kernel`. */
  id: string;
  label: string;
  /** 8sim-native card type (serial | other | …). */
  type: string;
  /** Peripheral endpoint this kernel's card binds to (e.g. 'terminal'). */
  binding?: string;
  /** Config surface the authored card inherits. */
  configSchema: Record<string, ConfigParamSpec>;
  /** Build the card's device (the same shape as a bundle's cardFactory). */
  create: CardFactory;
  /** Declared bus resources for define-time collision checks. */
  claims: ClaimsFn;
  /** Memory region(s) this kernel's card maps — e.g. a video card's RAM. Hoisted
   * into MachineSpec.memory so it's overlap-validated and shows on the ribbon. */
  memory?: (config: Record<string, unknown>) => MemoryRegionSpec[];
}

/** A serial (UART) console card: a data + status/control port, bound to a terminal. */
export const serialKernel: CardKernel = {
  id: 'serial',
  label: 'Serial UART (console)',
  type: 'serial',
  binding: 'terminal',
  configSchema: {
    dataPort: { type: 'u8', default: 0x10, min: 0, max: 0xff, description: 'Data register port' },
    ctrlPort: { type: 'u8', default: 0x11, min: 0, max: 0xff, description: 'Status/control port' },
    chip: { type: 'enum', default: 'i8251', enum: ['i8251', 'm6850'], description: 'UART chip' },
  },
  create: (id, cfg) =>
    new SerialCard(id, {
      dataPort: u8(cfg.dataPort, 0x10),
      ctrlPort: u8(cfg.ctrlPort, 0x11),
      chip: (cfg.chip as SerialChip) ?? 'i8251',
    }),
  claims: (cfg) => ({ ports: [u8(cfg.dataPort, 0x10), u8(cfg.ctrlPort, 0x11)] }),
};

/** A parallel I/O port: a single 8-bit latched port bound to GPIO (LEDs, switches, printer). */
export const parallelKernel: CardKernel = {
  id: 'parallel',
  label: 'Parallel I/O port',
  type: 'parallel',
  binding: 'gpio',
  configSchema: {
    port: { type: 'u8', default: 0x00, min: 0, max: 0xff, description: 'I/O port' },
    direction: { type: 'enum', default: 'out', enum: ['out', 'in', 'inout'], description: 'Data direction' },
  },
  create: (id, cfg) =>
    new ParallelCard(id, { port: u8(cfg.port, 0x00), direction: (cfg.direction as PortDirection) ?? 'out' }),
  claims: (cfg) => ({ ports: [u8(cfg.port, 0x00)] }),
};

/** An ASCII keyboard input port: a data + status port bound to the operator's keyboard. */
export const keyboardKernel: CardKernel = {
  id: 'keyboard',
  label: 'Keyboard input port (ASCII)',
  type: 'keyboard',
  binding: 'keyboard',
  configSchema: {
    dataPort: { type: 'u8', default: 0x01, min: 0, max: 0xff, description: 'Key data register port' },
    statusPort: { type: 'u8', default: 0x00, min: 0, max: 0xff, description: 'Key-ready status port' },
    readyMask: { type: 'u8', default: 0x01, min: 0, max: 0xff, description: 'Status bits set while a key waits' },
    readyPolarity: {
      type: 'enum',
      default: 'active-high',
      enum: ['active-high', 'active-low'],
      description: 'Ready-bit polarity (Sol-20 keyboard is active-low)',
    },
  },
  create: (id, cfg) =>
    new KeyboardCard(id, {
      dataPort: u8(cfg.dataPort, 0x01),
      statusPort: u8(cfg.statusPort, 0x00),
      readyMask: u8(cfg.readyMask, 0x01),
      readyActiveLow: cfg.readyPolarity === 'active-low',
    }),
  claims: (cfg) => ({ ports: [u8(cfg.dataPort, 0x01), u8(cfg.statusPort, 0x00)] }),
};

/** Processor Technology VDM-1: a memory-mapped 64×16 character display, bound to a monitor. */
export const vdmKernel: CardKernel = {
  id: 'vdm-video',
  label: 'VDM-1 video (64×16 characters)',
  type: 'video',
  binding: 'display',
  configSchema: {
    base: { type: 'u16', default: 0xcc00, min: 0, max: 0xffff, description: 'Video RAM base' },
    dstatPort: { type: 'u8', default: 0xfe, min: 0, max: 0xff, description: 'Display-parameter (scroll) port' },
  },
  create: (id, cfg) => new VdmCard(id, { base: u16(cfg.base, 0xcc00), dstatPort: u8(cfg.dstatPort, 0xfe) }),
  claims: (cfg) => ({ ports: [u8(cfg.dstatPort, 0xfe)] }),
  memory: (cfg) => [{ id: 'vram', base: u16(cfg.base, 0xcc00), size: 0x400, kind: 'ram' }],
};

/** Cromemco Dazzler: a DMA colour-graphics card driven by two I/O ports, bound to a monitor. */
export const dazzlerKernel: CardKernel = {
  id: 'dazzler-video',
  label: 'Cromemco Dazzler (colour graphics)',
  type: 'video',
  binding: 'display',
  configSchema: {
    controlPort: { type: 'u8', default: 0x0e, min: 0, max: 0xff, description: 'Control port (picture on + buffer page)' },
    formatPort: { type: 'u8', default: 0x0f, min: 0, max: 0xff, description: 'Format port (resolution / colour)' },
  },
  create: (id, cfg) =>
    new DazzlerCard(id, { controlPort: u8(cfg.controlPort, 0x0e), formatPort: u8(cfg.formatPort, 0x0f) }),
  claims: (cfg) => ({ ports: [u8(cfg.controlPort, 0x0e), u8(cfg.formatPort, 0x0f)] }),
  // No `memory`: the Dazzler DMAs ordinary system RAM, so it declares no region.
};

/** National MM58167 real-time clock: BCD time registers on an I/O window, bound to the host clock. */
export const rtcKernel: CardKernel = {
  id: 'mm58167-rtc',
  label: 'MM58167 real-time clock',
  type: 'rtc',
  binding: 'clock',
  configSchema: {
    base: { type: 'u8', default: 0x40, min: 0, max: 0xe0, description: 'Base I/O port (occupies base..base+0x1F)' },
  },
  create: (id, cfg, ctx) =>
    new RtcCard(id, { base: u8(cfg.base, 0x40) }, ctx.services.clock as RtcClock | undefined),
  // 32 consecutive registers.
  claims: (cfg) => {
    const b = u8(cfg.base, 0x40);
    return { ports: Array.from({ length: 0x20 }, (_v, i) => (b + i) & 0xff) };
  },
};

/** Bank-switching RAM: N banks of RAM behind a fixed window, selected by an I/O port (>64K). */
export const bankRamKernel: CardKernel = {
  id: 'bank-ram',
  label: 'Bank-switching RAM (MMU)',
  type: 'memory',
  configSchema: {
    window: { type: 'u16', default: 0xc000, min: 0, max: 0xffff, description: 'Switched window base address' },
    size: { type: 'u16', default: 0x4000, min: 1, max: 0xffff, description: 'Bytes visible per bank' },
    banks: { type: 'u8', default: 4, min: 1, max: 0xff, description: 'Number of RAM banks' },
    selectPort: { type: 'u8', default: 0x40, min: 0, max: 0xff, description: 'Bank-select I/O port' },
  },
  create: (id, cfg) =>
    new BankRamCard(id, {
      window: u16(cfg.window, 0xc000),
      size: u16(cfg.size, 0x4000),
      banks: u8(cfg.banks, 4),
      selectPort: u8(cfg.selectPort, 0x40),
    }),
  claims: (cfg) => ({ ports: [u8(cfg.selectPort, 0x40)] }),
};

/**
 * Boot / phantom ROM overlay: a monitor/boot ROM shadows a fixed window at
 * power-on (so the CPU runs firmware straight out of reset), then a write to the
 * control port pages it out to reveal the RAM underneath — the S-100 autoboot
 * trick (Cromemco 64FDC boot ROM, IMSAI MPU-B shadow ROM). The card owns its
 * window; the host resolver *consumes* the `rom` region below (injects the burned
 * image into config, omits the region from the spec) since the card attaches its
 * own overlay memory. `type: 'boot-rom'` is the marker the host keys that on.
 */
export const bootRomKernel: CardKernel = {
  id: 'boot-rom',
  label: 'Boot / phantom ROM overlay',
  type: 'boot-rom',
  configSchema: {
    window: { type: 'u16', default: 0xc000, min: 0, max: 0xffff, description: 'Overlay window base address' },
    size: { type: 'u16', default: 0x0800, min: 1, max: 0xffff, description: 'Overlay size in bytes' },
    controlPort: { type: 'u8', default: 0x40, min: 0, max: 0xff, description: 'Control port — a write pages the overlay out' },
    writeThrough: {
      type: 'enum',
      default: 'through',
      enum: ['through', 'drop'],
      description: 'Writes under the ROM: fall through to shadow RAM (through) or drop while mapped (drop)',
    },
  },
  create: (id, cfg) =>
    new BootRomCard(id, {
      window: u16(cfg.window, 0xc000),
      size: u16(cfg.size, 0x0800),
      controlPort: u8(cfg.controlPort, 0x40),
      writeThrough: cfg.writeThrough !== 'drop',
      image: cfg.image instanceof Uint8Array ? cfg.image : undefined,
    }),
  claims: (cfg) => ({ ports: [u8(cfg.controlPort, 0x40)] }),
  // Burn geometry + digest/override carrier only — the resolver consumes it.
  memory: (cfg) => [{ id: 'rom', base: u16(cfg.window, 0xc000), size: u16(cfg.size, 0x0800), kind: 'rom' }],
};

/** All built-in behavior kernels, keyed by id. */
export const kernels: ReadonlyArray<CardKernel> = [
  serialKernel,
  parallelKernel,
  keyboardKernel,
  vdmKernel,
  dazzlerKernel,
  rtcKernel,
  bankRamKernel,
  bootRomKernel,
];

export const kernelById = (id: string): CardKernel | undefined => kernels.find((k) => k.id === id);
