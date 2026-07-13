/**
 * Boot the Processor Technology CUTER monitor over the virtual 3P+S serial card.
 *
 * CUTER is the generic-S-100 sibling of SOLOS — a 2 KB ROM monitor at 0xC000
 * that drives a 3P+S-style serial console (status = port 0, data = port 1) with
 * the PT-native status convention (TBE = bit 7, RDA = bit 6) that the
 * {@link ProcTech3pSCard} defaults to. On startup CUTER reads the sense switches
 * (port 0xFF) to choose its console device; bits 1-0 select the output device
 * and bits 3-2 the input device, where device 1 = serial — so 0x05 routes both
 * to the 3P+S. It then prints a `>` prompt and accepts commands (DU dump, EN
 * enter, EX exec, ...). No disk or cassette required.
 *
 *   npm run boot:cuter
 *
 * Try:  DU C000 C00F   (dump the ROM)   — Ctrl-] to quit.
 *
 * cuter.bin is assembled from bios/sol20/cuter.asm by bios/sol20/build-cuter.sh.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Cpu8080 } from '../src/cpu/Cpu8080.js';
import { InterruptController } from '../src/interrupt/InterruptController.js';
import { Ram } from '../src/memory/Ram.js';
import { Rom } from '../src/memory/Rom.js';
import { Bus } from '../src/bus/Bus.js';
import { ProcTech3pSCard } from '../src/cards/ProcTech3pSCard.js';
import { Port8212 } from '../src/cards/Port8212.js';
import { MachineRunner } from '../src/machine/MachineRunner.js';

const ROM_PATH = join(process.cwd(), 'bios/sol20/cuter.bin');
const ROM_BASE = 0xc000;

function main(): void {
  if (!existsSync(ROM_PATH)) {
    console.error(`CUTER ROM not found at ${ROM_PATH} — run bios/sol20/build-cuter.sh first.`);
    process.exit(1);
  }
  const rom = new Uint8Array(readFileSync(ROM_PATH)).slice(0, 0x800);

  const pic = new InterruptController();
  const bus = new Bus(pic);
  bus.attachMemory(new Ram('lo', 0x0000, ROM_BASE));
  bus.attachMemory(new Rom('cuter', ROM_BASE, rom));
  bus.attachMemory(new Ram('hi', ROM_BASE + rom.length, 0x10000 - (ROM_BASE + rom.length)));

  const card = new ProcTech3pSCard('3ps', { baseAddress: 0x00 }); // status=0, data=1, PT-native
  card.attach(bus);

  // Sense switches (port 0xFF): 0x05 = console in+out on the serial device.
  const sense = new Port8212('sense', 0xff);
  sense.setInput(0x05);
  bus.attachIODevice(sense);

  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.pc = ROM_BASE;

  card.serial.onTransmit((byte) => process.stdout.write(String.fromCharCode(byte & 0x7f)));
  const stdin = process.stdin;
  const shutdown = (msg: string): void => {
    if (stdin.isTTY) stdin.setRawMode(false);
    process.stdout.write(`\r\n${msg}\r\n`);
    process.exit(0);
  };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (buf: Buffer) => {
    for (const byte of buf) {
      if (byte === 0x1d) { shutdown('[stopped]'); return; } // Ctrl-]
      // CUTER expects CR (0x0D); most terminals send it, but map LF→CR to be safe.
      card.serial.enqueueRx(byte === 0x0a ? 0x0d : byte);
    }
  });
  process.on('SIGINT', () => shutdown('[stopped]'));

  process.stdout.write('Booting Processor Technology CUTER on the 3P+S... (Ctrl-] to quit)\r\n');
  const runner = new MachineRunner(cpu, {
    hz: 2_000_000,
    schedule: (fn, ms) => { if (ms > 0) setTimeout(fn, ms); else setImmediate(fn); },
    onError: (e) => shutdown(`[cpu error: ${String(e)}]`),
  });
  runner.start();
}

main();
