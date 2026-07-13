import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';
import { ImsaiMdcDioCard } from '../../src/cards/ImsaiMdcDioCard.js';
import { InMemoryMdcDioDisk } from '../../src/cards/mdcdio/MdcDioDisk.js';

/**
 * Boot from a real IMDOS disk image (guarded on tests/fixtures/imdos202.dsk).
 * The bootstrap reads track 0 / sector 1 of drive 0 into 0x0000-0x007F and
 * `JMP 0000` — the front-panel "EXAMINE E000, RUN" flow.
 */

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
const FIXTURE = join(import.meta.dirname ?? '', '../fixtures/imdos202.dsk');

function machine(image: Uint8Array) {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0x0000, 0xe000); // 0..DFFF, clear of the E000 window
  bus.attachMemory(ram);
  const disk = new InMemoryMdcDioDisk('std-sd', image);
  const card = new ImsaiMdcDioCard('mdc', { disks: { 'std:0': disk } });
  card.attach(bus);
  return { bus, ram, pic };
}

describe('MDC-DIO IMDOS boot', () => {
  it('the boot trap DMAs track0/sector1 to 0x0000-0x007F', async () => {
    if (!existsSync(FIXTURE)) return; // fixture optional
    const image = new Uint8Array(readFileSync(FIXTURE));
    const { bus, ram } = machine(image);
    bus.write(0xec03, 0x00); // trigger boot-standard trap
    await flush();
    expect(bus.read(0xec03)).toBe(0x01); // status: success
    for (let i = 0; i < 128; i++) expect(ram.read(i)).toBe(image[i]);
  });

  it('a real CPU booting from E000 lands the boot sector and jumps to 0x0000', async () => {
    if (!existsSync(FIXTURE)) return;
    const image = new Uint8Array(readFileSync(FIXTURE));
    const { bus, ram, pic } = machine(image);
    const cpu = new Cpu8080(bus, pic);
    cpu.reset();
    cpu.registers.sp = 0xdf00;
    cpu.registers.pc = 0xe000; // EXAMINE E000 + RUN (standard-drive boot)

    // Run until control reaches 0x0000 (the JMP 0000 after the boot DMA).
    let reachedZero = false;
    let snapshot0 = -1;
    outer: for (let b = 0; b < 500; b++) {
      for (let i = 0; i < 50_000; i++) {
        cpu.step();
        if (cpu.registers.pc === 0x0000) {
          reachedZero = true;
          snapshot0 = ram.read(0);
          break outer;
        }
        if (cpu.halted) break outer;
      }
      await flush();
    }
    expect(reachedZero).toBe(true);
    // At the instant control transfers, 0x0000 holds the boot sector's first byte.
    expect(snapshot0).toBe(image[0]);
  });
});
