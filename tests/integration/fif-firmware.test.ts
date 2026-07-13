import { describe, it, expect } from 'vitest';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';
import { ImsaiFifCard } from '../../src/cards/ImsaiFifCard.js';
import { InMemoryFloppyDisk } from '../../src/cards/floppy/FloppyDisk.js';

/**
 * End-to-end: a real Cpu8080 drives the FIF exactly as z80pack's boot code does
 * — set pointer 0 to a descriptor with three `OUT 0xFD`s, `OUT 0xFD, 0` to
 * execute, then poll the descriptor's result byte in main RAM. The command
 * completes on a microtask (async disk backend), so the run loop batches steps
 * and yields to the event loop between batches, letting the poll loop exit.
 */

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

async function runToHalt(cpu: Cpu8080, maxBatches = 2000): Promise<boolean> {
  for (let b = 0; b < maxBatches; b++) {
    for (let i = 0; i < 50_000 && !cpu.halted; i++) cpu.step();
    if (cpu.halted) return true;
    await flush();
  }
  return false;
}

function machine(disk: InMemoryFloppyDisk) {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0x0000, 0x10000); // FIF is I/O-only → full 64K RAM
  bus.attachMemory(ram);
  const card = new ImsaiFifCard('fif', { disks: { '0': disk } });
  card.attach(bus);
  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.sp = 0xdf00;
  cpu.registers.pc = 0x0100;
  return { cpu, ram };
}

// Guest at 0x0100: set pointer 0 → descriptor@0x0140, execute, poll result, HLT.
function loadGuest(ram: Ram, descriptor: number[]): void {
  const prog = [
    0x3e, 0x10, 0xd3, 0xfd, // MVI A,10 ; OUT FD   (set pointer 0)
    0x3e, 0x40, 0xd3, 0xfd, // MVI A,40 ; OUT FD   (desc lo = 0x40)
    0x3e, 0x01, 0xd3, 0xfd, // MVI A,01 ; OUT FD   (desc hi = 0x01)
    0xaf, 0xd3, 0xfd, // XRA A ; OUT FD            (execute pointer 0)
    0x3a, 0x41, 0x01, // poll: LDA 0141           (descriptor result byte)
    0xb7, // ORA A
    0xca, 0x0f, 0x01, // JZ poll
    0x76, // HLT
  ];
  ram.load(new Uint8Array(prog), 0x0100);
  ram.load(new Uint8Array(descriptor), 0x0140);
}

describe('IMSAI FIF end-to-end (real Cpu8080, z80pack boot idiom)', () => {
  it('READ: OUT 0xFD executes a descriptor and DMAs a sector into RAM', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    const pattern = new Uint8Array(128).map((_, i) => (i ^ 0x5a) & 0xff);
    await disk.writeSector(1, 2, pattern);
    const { cpu, ram } = machine(disk);
    // READ (cmd 2, unit 1), track 1, sector 2, buffer 0x0300.
    loadGuest(ram, [0x21, 0x00, 0x00, 0x01, 0x02, 0x00, 0x03]);

    expect(await runToHalt(cpu)).toBe(true);
    expect(cpu.registers.a).toBe(0x01); // polled result byte
    expect(ram.read(0x0141)).toBe(0x01); // result written by DMA
    for (let i = 0; i < 128; i++) expect(ram.read(0x0300 + i)).toBe(pattern[i]);
  });

  it('WRITE: a sector built in RAM is DMAd to the disk', async () => {
    const disk = new InMemoryFloppyDisk('std-sd');
    const { cpu, ram } = machine(disk);
    for (let i = 0; i < 128; i++) ram.write(0x0300 + i, (i * 5) & 0xff);
    // WRITE (cmd 1, unit 1), track 4, sector 5, buffer 0x0300.
    loadGuest(ram, [0x11, 0x00, 0x00, 0x04, 0x05, 0x00, 0x03]);

    expect(await runToHalt(cpu)).toBe(true);
    expect(cpu.registers.a).toBe(0x01);
    const back = await disk.readSector(4, 5);
    for (let i = 0; i < 128; i++) expect(back[i]).toBe((i * 5) & 0xff);
  });
});
