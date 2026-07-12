import type { CardFactory } from '../machine/MachineSpec.js';
import type { ConfigParamSpec, ClaimsFn } from './CardBundle.js';
import { SerialCard, type SerialChip } from '../cards/SerialCard.js';
import { ParallelCard, type PortDirection } from '../cards/ParallelCard.js';

const u8 = (v: unknown, fallback: number): number => (typeof v === 'number' ? v & 0xff : fallback);

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

/** All built-in behavior kernels, keyed by id. */
export const kernels: ReadonlyArray<CardKernel> = [serialKernel, parallelKernel];

export const kernelById = (id: string): CardKernel | undefined => kernels.find((k) => k.id === id);
