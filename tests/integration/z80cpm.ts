import { CpuZ80 } from '../../src/cpu/z80/CpuZ80.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';

export interface CpmResult {
  output: string;
  steps: number;
  halted: boolean;
  completed: boolean; // reached the warm-boot vector at 0x0000
}

export interface CpmOptions {
  maxSteps?: number;
  /** Called with each character the program emits (for streaming long runs). */
  onChar?: (ch: string) => void;
}

/**
 * Run a CP/M .COM program under a stubbed BDOS, mirroring the 8080 cpudiag
 * harness. The program is loaded at 0x0100; calls to BDOS (0x0005) are
 * intercepted for CONOUT (C=2) and PRINT STRING (C=9); execution stops when the
 * program jumps/returns to the warm-boot vector at 0x0000.
 */
export function runCpmProgram(binary: Uint8Array, opts: CpmOptions | number = {}): CpmResult {
  const options: CpmOptions = typeof opts === 'number' ? { maxSteps: opts } : opts;
  const maxSteps = options.maxSteps ?? 5_000_000;
  const onChar = options.onChar;
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0, 0x10000);
  bus.attachMemory(ram);
  const cpu = new CpuZ80(bus, pic);

  ram.load(binary, 0x0100);
  // Warm-boot vector (JP 0x0000) and a RET at the BDOS entry, matching CP/M.
  ram.write(0x0000, 0xc3);
  ram.write(0x0001, 0x00);
  ram.write(0x0002, 0x00);
  ram.write(0x0005, 0xc9);

  cpu.regs.pc = 0x0100;
  cpu.regs.sp = 0xf000;

  let output = '';
  let steps = 0;
  let completed = false;

  while (steps < maxSteps) {
    const pc = cpu.regs.pc;
    if (pc === 0x0005) {
      const c = cpu.regs.c;
      if (c === 2) {
        const s = String.fromCharCode(cpu.regs.e);
        output += s;
        onChar?.(s);
      } else if (c === 9) {
        let addr = cpu.regs.de;
        for (let i = 0; i < 65536; i++) {
          const ch = ram.read(addr & 0xffff);
          if (ch === 0x24) break; // '$'
          const s = String.fromCharCode(ch);
          output += s;
          onChar?.(s);
          addr++;
        }
      }
      // Simulate RET from BDOS.
      const lo = ram.read(cpu.regs.sp);
      const hi = ram.read((cpu.regs.sp + 1) & 0xffff);
      cpu.regs.sp = (cpu.regs.sp + 2) & 0xffff;
      cpu.regs.pc = (hi << 8) | lo;
      steps++;
      continue;
    }
    if (pc === 0x0000) {
      completed = true;
      break;
    }
    if (cpu.halted) break;
    cpu.step();
    steps++;
  }

  return { output, steps, halted: cpu.halted, completed };
}
