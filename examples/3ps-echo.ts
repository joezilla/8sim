/**
 * Processor Technology 3P+S serial demo.
 *
 * Builds an 8080 + 64K RAM + a 3P+S I/O card (control/status = port 0, UART data
 * = port 1, PT-native status: TBE=0x80, RDA=0x40), loads the manual's Appendix-V
 * echo loop at 0x0000, and runs it. Characters you type are delivered to the
 * UART's receiver and the guest echoes them back through the UART transmitter —
 * a real serial round-trip through the virtual 3P+S. Ctrl-] quits.
 *
 *   npm run example:3ps
 */
import { Cpu8080 } from '../src/cpu/Cpu8080.js';
import { InterruptController } from '../src/interrupt/InterruptController.js';
import { Ram } from '../src/memory/Ram.js';
import { Bus } from '../src/bus/Bus.js';
import { ProcTech3pSCard } from '../src/cards/ProcTech3pSCard.js';
import { MachineRunner } from '../src/machine/MachineRunner.js';

// Appendix-V echo loop (ORG 0): wait RDA, read data, wait TBE, transmit, repeat.
const ECHO_LOOP = [
  0xdb, 0x00, // LOOP: IN STATUS
  0xe6, 0x40, //       ANI RDA (0x40)
  0xca, 0x00, 0x00, // JZ LOOP
  0xdb, 0x01, //       IN PORT1  (read RX, clears RDA)
  0x47, //             MOV B,A
  0xdb, 0x00, // TXW:  IN STATUS
  0xe6, 0x80, //       ANI TBE (0x80)
  0xca, 0x0a, 0x00, // JZ TXW
  0x78, //             MOV A,B
  0xd3, 0x01, //       OUT PORT1 (transmit)
  0xc3, 0x00, 0x00, // JMP LOOP
];

function main(): void {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0x0000, 0x10000);
  bus.attachMemory(ram);
  ram.load(new Uint8Array(ECHO_LOOP), 0x0000);

  const card = new ProcTech3pSCard('3ps', { baseAddress: 0x00 }); // CDAB, PT-native
  card.attach(bus);
  card.wireToConsole(); // serial TX → stdout

  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.sp = 0xf000;
  cpu.registers.pc = 0x0000;

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
      card.serial.enqueueRx(byte); // keyboard → UART receiver
    }
  });
  process.on('SIGINT', () => shutdown('[stopped]'));

  process.stdout.write('3P+S serial echo — type and it echoes back. (Ctrl-] to quit)\r\n');
  const runner = new MachineRunner(cpu, {
    hz: 2_000_000,
    schedule: (fn, ms) => { if (ms > 0) setTimeout(fn, ms); else setImmediate(fn); },
    onError: (e) => shutdown(`[cpu error: ${String(e)}]`),
  });
  runner.start();
}

main();
