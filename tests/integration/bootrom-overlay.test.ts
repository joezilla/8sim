import { describe, it, expect } from 'vitest';
import { buildMachine, BootRomCard } from '../../src/index.js';
import type { MachineSpec } from '../../src/machine/MachineSpec.js';

/**
 * Machine-level proof of the boot-ROM overlay autoboot pattern (Cromemco 64FDC /
 * IMSAI MPU-B): the CPU runs firmware straight out of reset while the overlay is
 * mapped in, the firmware pages the overlay out via the control port, and
 * execution then continues from the RAM the overlay was hiding. The overlay
 * window is owned solely by the boot-ROM card (RAM sits below it) — the engine's
 * Bus is first-region-wins, so the window must be clear of other memory.
 */
describe('boot-ROM overlay — autoboot then page-out (machine level)', () => {
  const WIN = 0xf000;

  // A self-paging boot monitor: copy an 8-byte stub to 0x0000 and JMP there; the
  // stub OUTs the control port (paging the ROM out from under itself is safe —
  // it runs from low RAM now), writes a sentinel, and HLTs.
  const rom = new Uint8Array([
    0x21, 0x13, 0xf0, // LXI H,0xF013  (stub source in ROM)
    0x11, 0x00, 0x00, // LXI D,0x0000  (dest in RAM)
    0x0e, 0x08,       // MVI C,8
    0x7e,             // MOV A,M   <-- copy loop @0xF008
    0x12,             // STAX D
    0x23,             // INX H
    0x13,             // INX D
    0x0d,             // DCR C
    0xc2, 0x08, 0xf0, // JNZ 0xF008
    0xc3, 0x00, 0x00, // JMP 0x0000
    0xd3, 0x40,       // OUT 0x40   (stub: page the overlay out)
    0x3e, 0x55,       // MVI A,0x55
    0x32, 0x00, 0x02, // STA 0x0200
    0x76,             // HLT
  ]);

  function machine() {
    const bootrom = new BootRomCard('boot', { window: WIN, size: 0x100, controlPort: 0x40, image: rom });
    const spec: MachineSpec = {
      cpuKind: 'i8080',
      clock: 'max',
      resetVector: WIN,
      memory: [{ id: 'ram', base: 0x0000, size: 0xf000, kind: 'ram' }],
      cards: [{ id: 'boot', factory: () => bootrom, config: {}, claims: { ports: [0x40] } }],
    };
    return buildMachine(spec);
  }

  it('boots from the overlay, pages it out, and continues in revealed RAM', () => {
    const m = machine();
    // Overlay mapped in at reset: the reset vector reads ROM's first opcode.
    expect(m.bus.read(WIN)).toBe(0x21);

    let steps = 0;
    while (!m.cpu.halted && steps < 100_000) { m.cpu.step(); steps++; }
    expect(m.cpu.halted).toBe(true);

    // The stub ran from low RAM AFTER paging the overlay out from under itself.
    expect(m.bus.read(0x0200)).toBe(0x55);
    // The window now reads the card's shadow RAM (zeroed), not the ROM image.
    expect(m.bus.read(WIN)).toBe(0x00);
  });
});
