import { describe, it, expect } from 'vitest';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';

function makeCpu(program: number[]): { cpu: Cpu8080; ram: Ram } {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0, 0x10000);
  ram.load(new Uint8Array(program));
  bus.attachMemory(ram);
  const cpu = new Cpu8080(bus, pic);
  cpu.registers.sp = 0x2000;
  return { cpu, ram };
}

describe('Stack instructions', () => {
  it('PUSH B pushes BC to stack', () => {
    const { cpu, ram } = makeCpu([0xc5]); // PUSH B
    cpu.registers.bc = 0x1234;
    cpu.step();
    expect(ram.read(0x1fff)).toBe(0x12); // B
    expect(ram.read(0x1ffe)).toBe(0x34); // C
    expect(cpu.registers.sp).toBe(0x1ffe);
  });

  it('POP B restores BC from stack', () => {
    const { cpu, ram } = makeCpu([0xc1]); // POP B
    cpu.registers.sp = 0x1ffe;
    ram.write(0x1ffe, 0x34); // C
    ram.write(0x1fff, 0x12); // B
    cpu.step();
    expect(cpu.registers.bc).toBe(0x1234);
    expect(cpu.registers.sp).toBe(0x2000);
  });

  it('PUSH/POP PSW preserves A and flags', () => {
    const { cpu } = makeCpu([0xf5, 0xf1]); // PUSH PSW, POP PSW
    cpu.registers.a = 0xaa;
    cpu.flags.cy = true;
    cpu.flags.z = true;
    cpu.flags.s = false;
    cpu.step(); // PUSH PSW
    cpu.registers.a = 0;
    cpu.flags.cy = false;
    cpu.flags.z = false;
    cpu.step(); // POP PSW
    expect(cpu.registers.a).toBe(0xaa);
    expect(cpu.flags.cy).toBe(true);
    expect(cpu.flags.z).toBe(true);
  });

  it('XTHL exchanges HL with stack top', () => {
    const { cpu, ram } = makeCpu([0xe3]); // XTHL
    cpu.registers.hl = 0xabcd;
    cpu.registers.sp = 0x1000;
    ram.write(0x1000, 0x34);
    ram.write(0x1001, 0x12);
    cpu.step();
    expect(cpu.registers.hl).toBe(0x1234);
    expect(ram.read(0x1000)).toBe(0xcd);
    expect(ram.read(0x1001)).toBe(0xab);
    expect(cpu.registers.sp).toBe(0x1000); // SP unchanged
  });

  it('SPHL sets SP to HL', () => {
    const { cpu } = makeCpu([0xf9]); // SPHL
    cpu.registers.hl = 0x3000;
    cpu.step();
    expect(cpu.registers.sp).toBe(0x3000);
  });
});
