import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Rom } from '../../src/memory/Rom.js';
import { Bus } from '../../src/bus/Bus.js';
import { VdmCard } from '../../src/cards/VdmCard.js';
import { KeyboardCard } from '../../src/cards/KeyboardCard.js';

/**
 * Boot the genuine Processor Technology SOLOS personality module on a Sol-20:
 * SOLOS ROM @0xC000 driving the built-in VDM-1 character display (video RAM
 * @0xCC00) and the Sol keyboard (data 0xFC, ready = bit 0 of status 0xFA,
 * active-low). This is the end-to-end proof that SOLOS drives the VDM console —
 * output lands in video RAM and typed commands echo + execute on screen, with
 * no serial line involved. Guarded on bios/sol20/solos.bin (built by
 * bios/sol20/build-solos.sh); skips if absent.
 */

const ROM_BASE = 0xc000;
const VDM_BASE = 0xcc00;

/** Read the VDM's 16×64 character buffer back as newline-joined text. */
function screenText(card: VdmCard): string {
  const bytes = card.display.frame().bytes;
  let s = '';
  for (let r = 0; r < 16; r++) {
    for (let c = 0; c < 64; c++) {
      const b = bytes[r * 64 + c]! & 0x7f; // strip the inverse-video bit
      s += b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ' ';
    }
    s += '\n';
  }
  return s;
}

function machine() {
  const romPath = join(import.meta.dirname ?? '', '../../bios/sol20/solos.bin');
  if (!existsSync(romPath)) return null;
  const rom = new Uint8Array(readFileSync(romPath)).slice(0, 0x800);

  const pic = new InterruptController();
  const bus = new Bus(pic);
  bus.attachMemory(new Ram('lo', 0x0000, ROM_BASE)); // 0x0000-0xBFFF program RAM
  bus.attachMemory(new Rom('solos', ROM_BASE, rom)); // 0xC000-0xC7FF SOLOS ROM
  bus.attachMemory(new Ram('hi', ROM_BASE + rom.length, 0x10000 - (ROM_BASE + rom.length))); // scratch + VDM RAM + high

  const vdm = new VdmCard('vdm', { base: VDM_BASE }); // claims DSTAT 0xFE too
  vdm.attach(bus);
  const kbd = new KeyboardCard('kbd', { dataPort: 0xfc, statusPort: 0xfa, readyMask: 0x01, readyActiveLow: true });
  kbd.attach(bus);

  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.pc = ROM_BASE; // Sol-20 reset jumps to the personality module

  const step = (n: number): void => { for (let i = 0; i < n && !cpu.halted; i++) cpu.step(); };
  return { screen: () => screenText(vdm), type: (s: string) => kbd.keyboard.type(s), step };
}

describe('SOLOS on the Sol-20 VDM-1 display', () => {
  it('boots to the > prompt and runs a DUMP command on screen', () => {
    const m = machine();
    if (!m) return; // ROM not built — skip

    m.step(3_000_000);
    expect(m.screen()).toContain('>'); // SOLOS painted its command prompt on the VDM

    // Type a DUMP of the ROM's first paragraph; SOLOS echoes the line and hex-dumps.
    m.type('DU C000 C00F\r');
    m.step(8_000_000);
    const out = m.screen();
    expect(out).toContain('DU C000 C00F'); // keystrokes echoed to the display
    expect(out).toContain('C000  00 C3 AF C1'); // hex dump of the SOLOS reset vector
  }, 30_000);
});
