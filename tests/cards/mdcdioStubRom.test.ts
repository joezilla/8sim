import { describe, it, expect } from 'vitest';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Bus } from '../../src/bus/Bus.js';
import { Ram } from '../../src/memory/Ram.js';
import { ImsaiMdcDioCard } from '../../src/cards/ImsaiMdcDioCard.js';
import {
  buildStubRom,
  ENTRY,
  STUB_ROM_SIZE,
  TRAP_CMD_STD,
} from '../../src/cards/mdcdio/stubRom.js';

const BASE = 0xe000;

describe('MDC-DIO stub ROM', () => {
  const rom = buildStubRom(BASE);

  it('is a full 2 KB image', () => {
    expect(rom.length).toBe(STUB_ROM_SIZE);
  });

  it('exposes C3 (JMP) at every entry vector — the manual\'s EXAMINE check', () => {
    for (const off of Object.values(ENTRY)) expect(rom[off]).toBe(0xc3);
  });

  it('the standard command vector jumps to an STA <trap>; poll; RET handler', () => {
    // vector at E006: C3 lo hi -> handler address
    const lo = rom[ENTRY.cmdStd + 1]!;
    const hi = rom[ENTRY.cmdStd + 2]!;
    const handler = (lo | (hi << 8)) - BASE;
    // handler begins: STA EC00  (32 00 EC)
    expect(rom[handler]).toBe(0x32); // STA
    expect(rom[handler + 1]).toBe(TRAP_CMD_STD & 0xff);
    expect(rom[handler + 2]).toBe((BASE + TRAP_CMD_STD) >> 8);
    // then LDA EC00 (3A 00 EC), ORA A (B7), JZ (CA), ... RET (C9) somewhere after
    expect(rom[handler + 3]).toBe(0x3a); // LDA
    expect(rom[handler + 6]).toBe(0xb7); // ORA A
    expect(rom[handler + 7]).toBe(0xca); // JZ
    expect(rom[handler + 10]).toBe(0xc9); // RET
  });

  it('boot handlers end in JMP 0000', () => {
    const lo = rom[ENTRY.bootStd + 1]!;
    const hi = rom[ENTRY.bootStd + 2]!;
    const handler = (lo | (hi << 8)) - BASE;
    // MVI A,0 (3E 00) at entry
    expect(rom[handler]).toBe(0x3e);
    // last three bytes of the handler are C3 00 00 (JMP 0000)
    // handler layout: 3E 00 | 32 04? no: STA boot-std trap | LDA | ORA | JZ | C3 00 00
    // find the JMP 0000 within the next 16 bytes
    let found = false;
    for (let i = handler; i < handler + 16; i++) {
      if (rom[i] === 0xc3 && rom[i + 1] === 0x00 && rom[i + 2] === 0x00) { found = true; break; }
    }
    expect(found).toBe(true);
  });

  it('serves C3 at E000/E003 once attached to a bus', () => {
    const pic = new InterruptController();
    const bus = new Bus(pic);
    bus.attachMemory(new Ram('ram', 0x0000, 0xe000)); // 0..DFFF, clear of the window
    const card = new ImsaiMdcDioCard('mdc', {});
    card.attach(bus);
    expect(bus.read(0xe000)).toBe(0xc3);
    expect(bus.read(0xe003)).toBe(0xc3);
  });
});
