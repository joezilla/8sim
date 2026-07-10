import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runCpmProgram } from './z80cpm.js';

/**
 * ZEXDOC / ZEXALL — the Z80 instruction exercisers. These run for billions of
 * T-states (minutes), so they are gated behind Z80_ZEX=1:
 *
 *   Z80_ZEX=1 npx vitest run tests/integration/z80-zex.test.ts
 *
 * Each sub-test prints a line ending in "OK" or "ERROR". Success = the
 * completion banner with no "ERROR".
 */
const enabled = process.env.Z80_ZEX === '1';

describe.skipIf(!enabled)('Z80 exercisers', () => {
  for (const name of ['zexdoc', 'zexall']) {
    it(`${name}.com reports all tests OK`, { timeout: 1_800_000 }, () => {
      const fixture = join(import.meta.dirname ?? '', `../fixtures/${name}.com`);
      if (!existsSync(fixture)) {
        throw new Error(`missing fixture ${name}.com — run: npm run fixtures:z80`);
      }
      const binary = readFileSync(fixture);
      const result = runCpmProgram(new Uint8Array(binary), {
        maxSteps: 20_000_000_000,
        onChar: (ch) => process.stdout.write(ch),
      });
      expect(result.output).not.toContain('ERROR');
      expect(result.output).toMatch(/tests complete/i);
    });
  }
});
