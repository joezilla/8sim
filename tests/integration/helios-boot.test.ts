import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Rom } from '../../src/memory/Rom.js';
import { Bus } from '../../src/bus/Bus.js';
import { HeliosCard } from '../../src/cards/HeliosCard.js';
import { InMemoryHeliosDisk } from '../../src/cards/helios/HeliosDisk.js';

/**
 * M2: the genuine SOLOS BOOTLOAD ROM's BOOT routine (@0xC367) drives the Helios
 * controller to bootstrap — proving the faithful controller satisfies the real
 * boot code end-to-end. BOOT restores unit 0, loads the head, waits for
 * index/ready, DMAs 832 bytes of track 0 → 0x0000, and RST 0s to it.
 */

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const BL_ROM = join(import.meta.dirname ?? '', '../../bios/sol20/bootload.bin');
const PROTEUS = join(import.meta.dirname ?? '', '../../bios/sol20/helios/b1d1-proteus.svh');

describe('Helios II boot via the real BOOTLOAD ROM', () => {
  it('BOOT (@0xC367) loads a synthetic track-0 payload to 0x0000 and runs it', async () => {
    if (!existsSync(BL_ROM)) return; // ROM not built — skip
    const rom = new Uint8Array(readFileSync(BL_ROM)).slice(0, 0x800);

    const pic = new InterruptController();
    const bus = new Bus(pic);
    bus.attachMemory(new Ram('lo', 0x0000, 0xc000));
    bus.attachMemory(new Rom('rom', 0xc000, rom));
    bus.attachMemory(new Ram('hi', 0xc800, 0x10000 - 0xc800));

    // Track 0 boot payload: MVI A,0x42 ; STA 0x3000 ; HLT — proves it loaded + ran.
    const payload = new Uint8Array(832);
    payload.set([0x3e, 0x42, 0x32, 0x00, 0x30, 0x76], 0);
    const disk = new InMemoryHeliosDisk();
    await disk.writeData(0, 0, payload);
    new HeliosCard('helios', { port: 0xf0, disks: { '0': disk } }).attach(bus);

    const cpu = new Cpu8080(bus, pic);
    cpu.reset();
    cpu.registers.sp = 0xbf00;
    cpu.registers.pc = 0xc367; // BOOT routine

    let halted = false;
    for (let b = 0; b < 300 && !halted; b++) {
      for (let i = 0; i < 50_000; i++) { cpu.step(); if (cpu.halted) { halted = true; break; } }
      await flush();
    }
    expect(halted).toBe(true);
    expect(bus.read(0x3000)).toBe(0x42); // the loaded payload executed
    for (let i = 0; i < 6; i++) expect(bus.read(i)).toBe(payload[i]); // DMA'd track 0 → 0x0000
  }, 30_000);

  it('reads track 0 of the real "proteus" PTDOS disk through the controller (M3)', async () => {
    if (!existsSync(PROTEUS)) return; // real-media fixture optional
    const disk = InMemoryHeliosDisk.fromSvh(new Uint8Array(readFileSync(PROTEUS)));
    const pic = new InterruptController();
    const bus = new Bus(pic);
    bus.attachMemory(new Ram('ram', 0x0000, 0x10000));
    const card = new HeliosCard('helios', { port: 0xf0, disks: { '0': disk } });
    card.attach(bus);

    bus.ioWrite(0xf7, 0xcf); // restore unit 0
    bus.ioWrite(0xf7, 0xdf); // load head
    bus.ioWrite(0xf5, 0x00); bus.ioWrite(0xf6, 0x10); // DMA addr 0x1000
    bus.ioWrite(0xf3, 0x40); bus.ioWrite(0xf4, 0x03); // length 0x340 = 832
    bus.ioWrite(0xf1, 0x03); // READ DATA
    await flush();
    expect(bus.ioRead(0xf0) & 0x01).toBe(0x01); // TC

    const expected = await disk.readData(0, 0, 832);
    for (let i = 0; i < 832; i++) expect(bus.read(0x1000 + i)).toBe(expected[i]);
    // the real disk's track 0 begins with recognizable data (not blank 0xFF)
    expect(bus.read(0x1000)).not.toBe(0xff);
  });
});
