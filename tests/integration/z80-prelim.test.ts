import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { runCpmProgram } from './z80cpm.js';

/**
 * prelim.com — a quick Z80 preliminary instruction sanity check (~1s).
 * Fetch with `npm run fixtures:z80`. Skipped if the fixture is absent.
 */
describe('Z80 prelim.com', () => {
  it('prints the preliminary-tests-complete banner', () => {
    const fixture = join(import.meta.dirname ?? '', '../fixtures/prelim.com');
    if (!existsSync(fixture)) return;

    const binary = readFileSync(fixture);
    const result = runCpmProgram(new Uint8Array(binary), 2_000_000);

    // prelim prints "Preliminary tests complete" on success.
    expect(result.output).toContain('complete');
    expect(result.output.toLowerCase()).not.toContain('error');
  });
});
