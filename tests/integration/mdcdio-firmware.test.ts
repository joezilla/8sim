import { describe, it, expect } from 'vitest';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';
import { ImsaiMdcDioCard } from '../../src/cards/ImsaiMdcDioCard.js';
import { InMemoryMdcDioDisk } from '../../src/cards/mdcdio/MdcDioDisk.js';

/**
 * End-to-end: a real Cpu8080 drives the MDC-DIO firmware API by CALLing the
 * stub-ROM entry points. Because a command completes on a microtask (the async
 * disk backend), the run loop batches CPU steps and yields to the event loop
 * between batches — exactly what MachineRunner does — so the stub's poll loop
 * sees the status go non-zero. This exercises CALL → stub → trap → DMA → poll → RET.
 */

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

async function runToHalt(cpu: Cpu8080, maxBatches = 2000): Promise<boolean> {
  for (let b = 0; b < maxBatches; b++) {
    for (let i = 0; i < 50_000 && !cpu.halted; i++) cpu.step();
    if (cpu.halted) return true;
    await flush(); // let pending disk Promises resolve, then the poll loop exits
  }
  return false;
}

function machine(disk: InMemoryMdcDioDisk) {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0x0000, 0xe000); // 0..DFFF, clear of the E000 window
  bus.attachMemory(ram);
  const card = new ImsaiMdcDioCard('mdc', { disks: { 'std:0': disk } });
  card.attach(bus);
  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.sp = 0xdf00;
  cpu.registers.pc = 0x0100;
  return { cpu, ram, bus };
}

// Guest: INIT, set pointer 0 → CMDSTR (0x0140), execute, HLT. A holds the status.
function loadGuest(ram: Ram, cmdString: number[]): void {
  const prog = [
    0xcd, 0x0c, 0xe0, // CALL E00C (INIT)
    0x3e, 0x10, 0xcd, 0x06, 0xe0, // MVI A,10 ; CALL E006  (set pointer 0)
    0x3e, 0x40, 0xcd, 0x06, 0xe0, // MVI A,40 ; CALL E006  (ptr lo = 0x40)
    0x3e, 0x01, 0xcd, 0x06, 0xe0, // MVI A,01 ; CALL E006  (ptr hi = 0x01)
    0x3e, 0x00, 0xcd, 0x06, 0xe0, // MVI A,00 ; CALL E006  (execute pointer 0)
    0x76, // HLT
  ];
  ram.load(new Uint8Array(prog), 0x0100);
  ram.load(new Uint8Array(cmdString), 0x0140);
}

describe('MDC-DIO firmware API end-to-end (real Cpu8080)', () => {
  it('READ: CALL E006 transfers a sector into main RAM, status in A', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    const pattern = new Uint8Array(128).map((_, i) => (i ^ 0x5a) & 0xff);
    await disk.writeSector(1, 2, pattern);

    const { cpu, ram } = machine(disk);
    // READ (cmd 2, drive 0), track 1, sector 2, buffer 0x0300
    loadGuest(ram, [0x21, 0x00, 0x00, 0x01, 0x02, 0x00, 0x03]);

    expect(await runToHalt(cpu)).toBe(true);
    expect(cpu.registers.a).toBe(0x01); // success returned in A
    expect(ram.read(0x0141)).toBe(0x01); // status also written to Byte2
    for (let i = 0; i < 128; i++) expect(ram.read(0x0300 + i)).toBe(pattern[i]);
  });

  it('WRITE: a sector built in RAM lands on the disk', async () => {
    const disk = new InMemoryMdcDioDisk('std-sd');
    const { cpu, ram } = machine(disk);
    for (let i = 0; i < 128; i++) ram.write(0x0300 + i, (i * 7) & 0xff);
    // WRITE (cmd 1, drive 0), track 5, sector 6, buffer 0x0300
    loadGuest(ram, [0x11, 0x00, 0x00, 0x05, 0x06, 0x00, 0x03]);

    expect(await runToHalt(cpu)).toBe(true);
    expect(cpu.registers.a).toBe(0x01);
    const back = await disk.readSector(5, 6);
    for (let i = 0; i < 128; i++) expect(back[i]).toBe((i * 7) & 0xff);
  });
});
