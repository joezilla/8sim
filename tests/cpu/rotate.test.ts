import { describe, it, expect } from 'vitest';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';

function makeCpu(program: number[]): Cpu8080 {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0, 0x10000);
  ram.load(new Uint8Array(program));
  bus.attachMemory(ram);
  return new Cpu8080(bus, pic);
}

describe('Rotate instructions', () => {
  it('RLC rotates left, bit7 to CY and bit0', () => {
    const cpu = makeCpu([0x07]); // RLC
    cpu.registers.a = 0x80;
    cpu.step();
    expect(cpu.registers.a).toBe(0x01);
    expect(cpu.flags.cy).toBe(true);
  });

  it('RRC rotates right, bit0 to CY and bit7', () => {
    const cpu = makeCpu([0x0f]); // RRC
    cpu.registers.a = 0x01;
    cpu.step();
    expect(cpu.registers.a).toBe(0x80);
    expect(cpu.flags.cy).toBe(true);
  });

  it('RAL rotates left through carry', () => {
    const cpu = makeCpu([0x17]); // RAL
    cpu.registers.a = 0x80;
    cpu.flags.cy = false;
    cpu.step();
    expect(cpu.registers.a).toBe(0x00);
    expect(cpu.flags.cy).toBe(true);
  });

  it('RAR rotates right through carry', () => {
    const cpu = makeCpu([0x1f]); // RAR
    cpu.registers.a = 0x01;
    cpu.flags.cy = true;
    cpu.step();
    expect(cpu.registers.a).toBe(0x80);
    expect(cpu.flags.cy).toBe(true);
  });

  it('RAL carries old CY into bit0', () => {
    const cpu = makeCpu([0x17]); // RAL
    cpu.registers.a = 0x01;
    cpu.flags.cy = true;
    cpu.step();
    expect(cpu.registers.a).toBe(0x03);
    expect(cpu.flags.cy).toBe(false);
  });
});
