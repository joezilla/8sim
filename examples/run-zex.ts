import { readFileSync } from 'fs';
import { runCpmProgram } from '../tests/integration/z80cpm.js';

const name = process.argv[2] ?? 'zexdoc';
const path = `tests/fixtures/${name}.com`;
const binary = new Uint8Array(readFileSync(path));

process.stdout.write(`Running ${name}.com ...\n`);
const start = Date.now();
const result = runCpmProgram(binary, {
  maxSteps: 40_000_000_000,
  onChar: (ch) => process.stdout.write(ch),
});
const secs = ((Date.now() - start) / 1000).toFixed(1);
process.stdout.write(`\n--- done in ${secs}s, ${result.steps} steps, completed=${result.completed} ---\n`);
