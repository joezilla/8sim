import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Rom } from '../../src/memory/Rom.js';
import { Bus } from '../../src/bus/Bus.js';
import { ImsaiSioCard } from '../../src/cards/ImsaiSioCard.js';
import { ImsaiFifCard } from '../../src/cards/ImsaiFifCard.js';
import { InMemoryFloppyDisk } from '../../src/cards/floppy/FloppyDisk.js';

/**
 * Full boot: the IMSAI MPU-A monitor ROM at 0xD800 auto-boots IMDOS 2.02 from
 * the FIF controller (drive 0 = imdos202.dsk), which loads the OS via OUT 0xFD.
 * The OS then talks to the SIO-2 console (channel A, 0x02/0x03). This is the
 * end-to-end proof that the FIF card boots a real operating system.
 *
 * Guarded on the disk fixture (the ROM ships in bios/). Skips if absent.
 */

const ROM_BASE = 0xd800;
const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

describe('IMSAI FIF full IMDOS boot', () => {
  it('boots IMDOS 2.02 to the A> prompt and lists the directory', async () => {
    const dir = import.meta.dirname ?? '';
    const romPath = join(dir, '../../bios/imsai-mpu-a-rom.bin');
    const diskPath = join(dir, '../fixtures/imdos202.dsk');
    if (!existsSync(romPath) || !existsSync(diskPath)) return; // artifacts optional

    const rom = new Uint8Array(readFileSync(romPath));
    const image = new Uint8Array(readFileSync(diskPath));

    const pic = new InterruptController();
    const bus = new Bus(pic);
    bus.attachMemory(new Ram('lo', 0x0000, ROM_BASE));
    bus.attachMemory(new Rom('mpu-a', ROM_BASE, rom));
    bus.attachMemory(new Ram('hi', ROM_BASE + rom.length, 0x10000 - (ROM_BASE + rom.length)));
    const sio = new ImsaiSioCard('sio', { basePortA: 0x02, basePortB: 0x04, boardCtrlPort: 0x08 });
    sio.attach(bus);
    const fif = new ImsaiFifCard('fif', { disks: { '0': new InMemoryFloppyDisk('std-sd', image) } });
    fif.attach(bus);

    let out = '';
    sio.channelA.onTransmit((b) => { out += String.fromCharCode(b & 0x7f); });

    const cpu = new Cpu8080(bus, pic);
    cpu.reset();
    cpu.registers.pc = ROM_BASE; // power-on jump into the monitor (auto-boots drive 0)

    const run = async (batches: number): Promise<void> => {
      for (let b = 0; b < batches; b++) {
        for (let i = 0; i < 50_000 && !cpu.halted; i++) cpu.step();
        await flush();
        if (cpu.halted) return;
      }
    };

    await run(250);
    expect(out).toContain('IMDOS VERS 2.02'); // OS booted and printed its sign-on
    expect(out).toContain('A>'); // reached the command prompt

    // Drive the prompt: DIR lists the directory (read via the FIF).
    for (const ch of 'DIR\r') sio.channelA.enqueueRx(ch.charCodeAt(0));
    await run(250);
    expect(out).toContain('PIP'); // a known file on the IMDOS system disk
  }, 30_000);
});
