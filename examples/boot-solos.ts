/**
 * Boot the Processor Technology SOLOS personality module on a virtual Sol-20.
 *
 * SOLOS is the Sol-20 stand-alone operating system — the ROM personality module
 * at 0xC000 that drives the machine's *built-in* console: the VDM-1 memory-
 * mapped character display (video RAM @0xCC00) and the Sol keyboard (data 0xFC,
 * ready = bit 0 of status 0xFA, active-low — SOLOS's KSTAT driver `CMA`s the
 * status byte before testing the ready bit). Unlike CUTER (the generic-S-100
 * sibling that talks to a 3P+S serial console, see boot-cuter.ts), SOLOS paints
 * straight to the screen, so this harness renders the VDM's 16×64 grid to your
 * terminal and feeds your keystrokes to the Sol keyboard.
 *
 *   npm run boot:solos
 *
 * Try:  DU C000 C00F  (dump the ROM)   — Ctrl-] to quit.
 *
 * solos.bin is assembled from bios/sol20/solos1.asm by bios/sol20/build-solos.sh.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Cpu8080 } from '../src/cpu/Cpu8080.js';
import { InterruptController } from '../src/interrupt/InterruptController.js';
import { Ram } from '../src/memory/Ram.js';
import { Rom } from '../src/memory/Rom.js';
import { Bus } from '../src/bus/Bus.js';
import { VdmCard } from '../src/cards/VdmCard.js';
import { KeyboardCard } from '../src/cards/KeyboardCard.js';
import { MachineRunner } from '../src/machine/MachineRunner.js';

const ROM_PATH = join(process.cwd(), 'bios/sol20/solos.bin');
const ROM_BASE = 0xc000;
const COLS = 64;
const ROWS = 16;

/** Repaint the VDM's 16×64 character buffer, honoring the DSTAT scroll origin. */
function render(vdm: VdmCard): void {
  const { bytes, state } = vdm.display.frame();
  const top = state.scroll ?? 0;
  let out = '\x1b[H'; // cursor home (screen was cleared once at startup)
  for (let r = 0; r < ROWS; r++) {
    const row = (top + r) % ROWS;
    let line = '';
    for (let c = 0; c < COLS; c++) {
      const b = bytes[row * COLS + c]! & 0x7f; // drop the inverse-video bit
      line += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ' ';
    }
    out += line + '\x1b[K\r\n'; // clear to EOL so shorter lines don't leave debris
  }
  process.stdout.write(out);
}

function main(): void {
  if (!existsSync(ROM_PATH)) {
    console.error(`SOLOS ROM not found at ${ROM_PATH} — run bios/sol20/build-solos.sh first.`);
    process.exit(1);
  }
  const rom = new Uint8Array(readFileSync(ROM_PATH)).slice(0, 0x800);

  const pic = new InterruptController();
  const bus = new Bus(pic);
  bus.attachMemory(new Ram('lo', 0x0000, ROM_BASE)); // 0x0000-0xBFFF program RAM
  bus.attachMemory(new Rom('solos', ROM_BASE, rom)); // 0xC000-0xC7FF SOLOS ROM
  bus.attachMemory(new Ram('hi', ROM_BASE + rom.length, 0x10000 - (ROM_BASE + rom.length))); // scratch + VDM + high RAM

  const vdm = new VdmCard('vdm', { base: 0xcc00 }); // display @0xCC00, DSTAT @0xFE
  vdm.attach(bus);
  const kbd = new KeyboardCard('kbd', { dataPort: 0xfc, statusPort: 0xfa, readyMask: 0x01, readyActiveLow: true });
  kbd.attach(bus);

  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.pc = ROM_BASE; // Sol-20 reset jumps into the personality module

  const stdin = process.stdin;
  let timer: ReturnType<typeof setInterval> | undefined;
  const shutdown = (msg: string): void => {
    if (timer) clearInterval(timer);
    if (stdin.isTTY) stdin.setRawMode(false);
    process.stdout.write(`\x1b[?25h\r\n${msg}\r\n`); // show cursor again
    process.exit(0);
  };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (buf: Buffer) => {
    for (const byte of buf) {
      if (byte === 0x1d) { shutdown('[stopped]'); return; } // Ctrl-]
      // SOLOS expects uppercase; the Sol keyboard was an uppercase-ASCII device.
      const b = byte === 0x0a ? 0x0d : byte; // map LF→CR
      kbd.keyboard.press(b >= 0x61 && b <= 0x7a ? b - 0x20 : b);
    }
  });
  process.on('SIGINT', () => shutdown('[stopped]'));

  process.stdout.write('\x1b[2J\x1b[?25l'); // clear screen, hide cursor
  const runner = new MachineRunner(cpu, {
    hz: 2_000_000,
    schedule: (fn, ms) => { if (ms > 0) setTimeout(fn, ms); else setImmediate(fn); },
    onError: (e) => shutdown(`[cpu error: ${String(e)}]`),
  });
  runner.start();
  timer = setInterval(() => render(vdm), 33); // ~30 fps repaint
}

main();
