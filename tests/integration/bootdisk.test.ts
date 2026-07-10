import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Rom } from '../../src/memory/Rom.js';
import { Bus } from '../../src/bus/Bus.js';
import { SnoopBus } from '../../src/bus/SnoopBus.js';
import type { IBusObserver } from '../../src/interfaces/IBusObserver.js';
import { ImsaiSioCard } from '../../src/cards/ImsaiSioCard.js';

/**
 * Boot harness for the MITS 88-DSK boot PROM.
 *
 * Machine configuration:
 *   - 48 KB RAM         : 0x0000 - 0xBFFF
 *   - Boot ROM (256 B)  : 0xFF00 - 0xFFFF   (88dskrom.bin)
 *   - IMSAI SIO serial  : data port 0x02, status/control port 0x03
 *   - PC boots at         0xFF00
 *
 * The 88-DSK PROM relocates ~230 bytes of itself into RAM at 0x4C00, jumps
 * there, then polls the 88-DCDD disk controller (ports 0x08-0x0A) to load
 * the first disk sector. No disk controller is wired up here (serial only),
 * so the CPU relocates correctly and then spins on the disk status port —
 * which this harness detects, reports, and turns into assertions.
 *
 * Run it and watch:  npx vitest run tests/integration/bootdisk.test.ts
 */
describe('88-DSK boot PROM harness', () => {
  it('relocates to RAM and drives the disk controller ports', () => {
    // --- Locate the boot ROM -------------------------------------------------
    const fixture = join(import.meta.dirname ?? '', '../fixtures/88dskrom.bin');
    const downloads =
      '/Users/jtoppe/Downloads/Altair32 Emulator for Windows v3.35/files/88dskrom.bin';
    const romPath = existsSync(fixture) ? fixture : downloads;
    if (!existsSync(romPath)) {
      console.warn(`boot ROM not found; place it at ${fixture}`);
      return;
    }
    const romBytes = new Uint8Array(readFileSync(romPath));

    // --- Build the machine ---------------------------------------------------
    const RAM_SIZE = 48 * 1024; // 0x0000 - 0xBFFF
    const ROM_BASE = 0xff00;
    const BOOT_PC = 0xff00;

    const pic = new InterruptController();
    const realBus = new Bus(pic);

    const ram = new Ram('ram48k', 0x0000, RAM_SIZE);
    const rom = new Rom('bootrom', ROM_BASE, romBytes);
    realBus.attachMemory(ram);
    realBus.attachMemory(rom);

    // IMSAI SIO serial card: basePortA 0x02 => data 0x02, status/ctrl 0x03.
    const sio = new ImsaiSioCard('sio', { basePortA: 0x02 });
    sio.attach(realBus);

    // Capture anything the machine transmits over the serial line.
    let serialOut = '';
    const onTx = (byte: number) => {
      serialOut += String.fromCharCode(byte);
      process.stdout.write(String.fromCharCode(byte));
    };
    sio.channelA.onTransmit(onTx);
    sio.channelB.onTransmit(onTx);

    // --- Snoop the bus so we can see where the boot goes ---------------------
    const ioReads = new Map<number, number>();
    const ioWrites = new Map<number, number>();
    let ramWrites = 0;
    let lastIoWriteStep = 0;
    let lastRamWriteStep = 0;

    const snoop: IBusObserver = {
      onMemWrite(address: number): void {
        if (address < RAM_SIZE) {
          ramWrites++;
          lastRamWriteStep = steps;
        }
      },
      onIoRead(port: number): void {
        ioReads.set(port, (ioReads.get(port) ?? 0) + 1);
      },
      onIoWrite(port: number): void {
        ioWrites.set(port, (ioWrites.get(port) ?? 0) + 1);
        lastIoWriteStep = steps;
      },
    };

    const bus = new SnoopBus(realBus);
    bus.attach(snoop);

    const cpu = new Cpu8080(bus, pic);
    cpu.reset();
    cpu.registers.pc = BOOT_PC;

    // --- Run with a stall detector -------------------------------------------
    // "Progress" = a RAM write or a serial/device write. The disk poll loop
    // does only IN 0x08 (an ioRead) forever, producing no progress — so a long
    // idle stretch means the boot is blocked waiting on the (absent) disk.
    let steps = 0;
    const MAX_STEPS = 5_000_000;
    const IDLE_LIMIT = 300_000; // steps with no write activity => stalled
    let stalled = false;

    while (!cpu.halted && steps < MAX_STEPS) {
      cpu.step();
      steps++;
      const idle = steps - Math.max(lastIoWriteStep, lastRamWriteStep);
      if (idle > IDLE_LIMIT) {
        stalled = true;
        break;
      }
    }

    // --- Report --------------------------------------------------------------
    const hex = (n: number, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');
    const hottestRead = [...ioReads.entries()].sort((a, b) => b[1] - a[1])[0];

    console.log('\n===== 88-DSK boot harness =====');
    console.log(`steps executed : ${steps}${stalled ? ' (stalled)' : cpu.halted ? ' (halted)' : ' (max steps)'}`);
    console.log(`final PC       : 0x${hex(cpu.registers.pc)}`);
    console.log(`final SP       : 0x${hex(cpu.registers.sp)}`);
    console.log(`RAM writes     : ${ramWrites}`);
    console.log(
      `I/O writes     : ${[...ioWrites.entries()]
        .map(([p, c]) => `0x${hex(p, 2)}×${c}`)
        .join(', ') || 'none'}`,
    );
    console.log(
      `I/O reads      : ${[...ioReads.entries()]
        .map(([p, c]) => `0x${hex(p, 2)}×${c}`)
        .join(', ') || 'none'}`,
    );
    if (hottestRead) {
      console.log(`polling port   : 0x${hex(hottestRead[0], 2)} (${hottestRead[1]} reads)`);
    }
    console.log(`serial output  : ${serialOut ? JSON.stringify(serialOut) : '(none)'}`);
    console.log('================================\n');

    // --- Assertions ----------------------------------------------------------
    // 1. The PROM copied its runtime portion (bytes 0x18..) into RAM at 0x4C00.
    for (let i = 0; i < 16; i++) {
      expect(ram.read(0x4c00 + i)).toBe(romBytes[0x18 + i]);
    }
    // 2. Execution left the ROM and is running relocated code in RAM.
    expect(cpu.registers.pc).toBeLessThan(RAM_SIZE);
    // 3. It set up its stack (LXI SP,0x4D62 in the relocated loader).
    expect(cpu.registers.sp).toBe(0x4d62);
    // 4. It reached the disk controller: selected a drive / loaded head via
    //    OUT 0x08 / OUT 0x09, then spun polling the disk status port 0x08.
    expect(ioWrites.has(0x08)).toBe(true);
    expect(ioWrites.has(0x09)).toBe(true);
    expect(stalled).toBe(true);
    expect(hottestRead?.[0]).toBe(0x08);
  });
});
