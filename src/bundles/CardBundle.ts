import type { CardFactory } from '../machine/MachineSpec.js';

/**
 * Declarative description of a card's configurable surface — the source both
 * the settings UI (later, fdcplus-web) and define-time validation are generated
 * from. Kept minimal and 8sim-native; the rich catalog metadata (docs, media,
 * identity, versioning) lives in fdcplus-web.
 */
export type ConfigParamType = 'u8' | 'u16' | 'enum';

export interface ConfigParamSpec {
  type: ConfigParamType;
  default: number | string;
  min?: number;
  max?: number;
  enum?: ReadonlyArray<number | string>;
  description?: string;
}

/**
 * The kind of bus primitive this bundle models. An S-100 machine is assembled
 * from `card`s (things that occupy a bus slot); a `chip` is a component that
 * lives ON a card (e.g. a 6850 ACIA on the 88-2SIO). 8sim can also expose a
 * bare chip as a minimal bus device (via `deviceCard`), so a `chip` primitive
 * is placeable, but it is a component reference — not a real S-100 board.
 */
export type PrimitiveKind = 'card' | 'chip';

export interface CardManifest {
  /** Bundle name (Identity is `name@version`). */
  name: string;
  version: string; // semver
  type: 'serial' | 'floppy' | 'memory' | 'panel' | 'other';
  /** Bus-ontology kind: an S-100 board vs. a component chip. Defaults to `card`. */
  kind?: PrimitiveKind;
  maker?: string;
  summary?: string;
  configSchema: Record<string, ConfigParamSpec>;
}

/** Resolved config → declared bus resources, for define-time collision rejection. */
export type ClaimsFn = (config: Record<string, unknown>) => {
  ports?: number[];
  irq?: number | null;
};

/**
 * A self-contained card bundle (AR-5): the manifest (data) + the uniform
 * factory (code) + a claims deriver. Seed bundles wrap the built-in 8sim card
 * classes; downstream bundles have the same shape.
 */
export interface CardBundle {
  manifest: CardManifest;
  cardFactory: CardFactory;
  claims: ClaimsFn;
}

/** Thrown when a card config violates its manifest's Config Schema. */
export class CardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardConfigError';
  }
}

/**
 * Merge a resolved config over the manifest's schema defaults, validating each
 * value against its ConfigParamSpec (range for `u8`/`u16`, membership for
 * `enum`). Throws {@link CardConfigError} on a violation so an out-of-range
 * port can't be silently masked into a different (and mis-claimed) one.
 *
 * Keys present in `config` but absent from the schema are ignored (the schema
 * is the contract) — a typo'd key silently takes its default.
 */
export function withDefaults(
  manifest: CardManifest,
  config: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(manifest.configSchema)) {
    const value = key in config ? config[key] : spec.default;
    validateParam(manifest.name, key, spec, value);
    out[key] = value;
  }
  return out;
}

function validateParam(card: string, key: string, spec: ConfigParamSpec, value: unknown): void {
  const where = `card "${card}" config "${key}"`;
  if (spec.type === 'enum') {
    if (!spec.enum || !spec.enum.includes(value as number | string)) {
      throw new CardConfigError(`${where}: ${JSON.stringify(value)} is not one of ${JSON.stringify(spec.enum ?? [])}`);
    }
    return;
  }
  // u8 / u16 numeric range.
  const hi = spec.max ?? (spec.type === 'u16' ? 0xffff : 0xff);
  const lo = spec.min ?? 0;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < lo || value > hi) {
    throw new CardConfigError(`${where}: ${JSON.stringify(value)} must be an integer in ${lo}..${hi}`);
  }
}
