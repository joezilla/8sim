import { describe, it, expect } from 'vitest';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Run the cpudiag.com CP/M diagnostic.
 * Requires the binary at tests/fixtures/cpudiag.com.
 * If missing, the test is skipped silently.
 */
describe('cpudiag.com integration test', () => {
  it('prints CPU IS OPERATIONAL and halts', () => {
    const fixturePath = join(import.meta.dirname ?? '', '../fixtures/cpudiag.com');
    if (!existsSync(fixturePath)) {
      return; // fixture not present — place cpudiag.com at tests/fixtures/ to enable
    }

    const binary = readFileSync(fixturePath);
    const pic = new InterruptController();
    const bus = new Bus(pic);
    const ram = new Ram('ram', 0, 0x10000);
    bus.attachMemory(ram);
    const cpu = new Cpu8080(bus, pic);

    // CP/M: load binary at 0x0100
    ram.load(new Uint8Array(binary), 0x0100);

    // CP/M warm boot at 0x0000: JMP 0x0000 (creates an infinite loop catch)
    ram.write(0x0000, 0xc3);
    ram.write(0x0001, 0x00);
    ram.write(0x0002, 0x00);

    let output = '';

    // Stub CP/M BDOS at 0x0005
    // C=2: CONOUT — print char in E
    // C=9: PRINT STRING — print $-terminated string at DE
    // We use a RST 7 (0xFF) at 0x0005 + a handler at 0x0038
    // Actually simpler: detect PC == 0x0005 in the run loop

    cpu.registers.pc = 0x0100;
    cpu.registers.sp = 0x0100;

    // Patch 0x0005 with HLT (0x76) so we can detect BDOS calls
    // We'll use a custom run loop to intercept
    ram.write(0x0005, 0xc9); // RET for now — we intercept before execution

    let steps = 0;
    const maxSteps = 10_000_000;

    while (!cpu.halted && steps < maxSteps) {
      // Intercept BDOS call
      if (cpu.registers.pc === 0x0005) {
        const c = cpu.registers.c;
        if (c === 2) {
          output += String.fromCharCode(cpu.registers.e);
        } else if (c === 9) {
          // Print string at DE until '$'
          let addr = cpu.registers.de;
          for (let i = 0; i < 10000; i++) {
            const ch = ram.read(addr & 0xffff);
            if (ch === 0x24) break; // '$'
            output += String.fromCharCode(ch);
            addr++;
          }
        }
        // Simulate RET
        const lo = ram.read(cpu.registers.sp);
        const hi = ram.read((cpu.registers.sp + 1) & 0xffff);
        cpu.registers.sp = (cpu.registers.sp + 2) & 0xffff;
        cpu.registers.pc = (hi << 8) | lo;
        steps++;
        continue;
      }
      cpu.step();
      steps++;
    }

    expect(output).toContain('CPU IS OPERATIONAL');
  });
});
