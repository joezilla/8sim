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

export interface CardManifest {
  /** Bundle name (Identity is `name@version`). */
  name: string;
  version: string; // semver
  type: 'serial' | 'floppy' | 'memory' | 'panel' | 'other';
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

/** Merge a resolved config over the manifest's schema defaults. */
export function withDefaults(
  manifest: CardManifest,
  config: Record<string, unknown> = {},
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(manifest.configSchema)) {
    out[key] = key in config ? config[key] : spec.default;
  }
  return out;
}
