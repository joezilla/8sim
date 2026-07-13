import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Rom } from '../../src/memory/Rom.js';
import { Bus } from '../../src/bus/Bus.js';
import { ProcTech3pSCard } from '../../src/cards/ProcTech3pSCard.js';
import { Port8212 } from '../../src/cards/Port8212.js';

/**
 * Boot the real Processor Technology CUTER monitor over the virtual 3P+S serial
 * card — the end-to-end proof that the 3P+S drives a genuine period monitor.
 * CUTER (2 KB ROM @ 0xC000) prints a `>` prompt and runs its command loop; the
 * DUMP command exercises the serial round-trip (echo + hex output). Guarded on
 * bios/sol20/cuter.bin (built by bios/sol20/build-cuter.sh); skips if absent.
 */

const ROM_BASE = 0xc000;

function machine() {
  const dir = import.meta.dirname ?? '';
  const romPath = join(dir, '../../bios/sol20/cuter.bin');
  if (!existsSync(romPath)) return null;
  const rom = new Uint8Array(readFileSync(romPath)).slice(0, 0x800);

  const pic = new InterruptController();
  const bus = new Bus(pic);
  bus.attachMemory(new Ram('lo', 0x0000, ROM_BASE));
  bus.attachMemory(new Rom('cuter', ROM_BASE, rom));
  bus.attachMemory(new Ram('hi', ROM_BASE + rom.length, 0x10000 - (ROM_BASE + rom.length)));
  const card = new ProcTech3pSCard('3ps', { baseAddress: 0x00 });
  card.attach(bus);
  const sense = new Port8212('sense', 0xff); // console in+out on the serial device
  sense.setInput(0x05);
  bus.attachIODevice(sense);
  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.pc = ROM_BASE;

  let out = '';
  card.serial.onTransmit((b) => { out += String.fromCharCode(b & 0x7f); });
  const step = (n: number): void => { for (let i = 0; i < n && !cpu.halted; i++) cpu.step(); };
  const send = (s: string): void => { for (const ch of s) card.serial.enqueueRx(ch.charCodeAt(0)); };
  return { getOut: () => out, step, send };
}

describe('CUTER monitor on the 3P+S', () => {
  it('boots to the > prompt and runs a DUMP command over the serial console', () => {
    const m = machine();
    if (!m) return; // ROM not built — skip

    m.step(2_000_000);
    expect(m.getOut()).toContain('>'); // CUTER printed its prompt

    // DUMP the ROM's first bytes; CUTER echoes the line then hex-dumps + re-prompts.
    m.send('DU C000 C00F\r');
    m.step(6_000_000);
    const out = m.getOut();
    expect(out).toContain('DU C000 C00F'); // command echoed back
    expect(out).toMatch(/C000\s+7F C3/); // dump shows the ROM start (7F C3 ...)
  }, 30_000);
});
