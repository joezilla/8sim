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

describe('Logical instructions', () => {
  it('ANA clears CY and AC, sets S/Z/P', () => {
    const cpu = makeCpu([0xa0]); // ANA B
    cpu.registers.a = 0xff;
    cpu.registers.b = 0x0f;
    cpu.step();
    expect(cpu.registers.a).toBe(0x0f);
    expect(cpu.flags.cy).toBe(false);
  });

  it('ANI masks A with immediate', () => {
    const cpu = makeCpu([0xe6, 0xf0]); // ANI 0xF0
    cpu.registers.a = 0xab;
    cpu.step();
    expect(cpu.registers.a).toBe(0xa0);
  });

  it('ORA sets bits', () => {
    const cpu = makeCpu([0xb0]); // ORA B
    cpu.registers.a = 0x0f;
    cpu.registers.b = 0xf0;
    cpu.step();
    expect(cpu.registers.a).toBe(0xff);
    expect(cpu.flags.cy).toBe(false);
    expect(cpu.flags.s).toBe(true);
  });

  it('ORI sets bits with immediate', () => {
    const cpu = makeCpu([0xf6, 0x0f]); // ORI 0x0F
    cpu.registers.a = 0xf0;
    cpu.step();
    expect(cpu.registers.a).toBe(0xff);
  });

  it('XRA exclusive-ORs', () => {
    const cpu = makeCpu([0xa8]); // XRA B
    cpu.registers.a = 0xff;
    cpu.registers.b = 0xf0;
    cpu.step();
    expect(cpu.registers.a).toBe(0x0f);
  });

  it('XRA A clears A and sets Z', () => {
    const cpu = makeCpu([0xaf]); // XRA A
    cpu.registers.a = 0x55;
    cpu.step();
    expect(cpu.registers.a).toBe(0);
    expect(cpu.flags.z).toBe(true);
    expect(cpu.flags.cy).toBe(false);
  });

  it('CMP sets flags without changing A', () => {
    const cpu = makeCpu([0xb8]); // CMP B
    cpu.registers.a = 5;
    cpu.registers.b = 5;
    cpu.step();
    expect(cpu.registers.a).toBe(5); // unchanged
    expect(cpu.flags.z).toBe(true);
    expect(cpu.flags.cy).toBe(false);
  });

  it('CPI sets carry when A < imm', () => {
    const cpu = makeCpu([0xfe, 0x10]); // CPI 0x10
    cpu.registers.a = 5;
    cpu.step();
    expect(cpu.flags.cy).toBe(true);
    expect(cpu.flags.z).toBe(false);
  });

  it('CMA complements A', () => {
    const cpu = makeCpu([0x2f]); // CMA
    cpu.registers.a = 0x5a;
    cpu.step();
    expect(cpu.registers.a).toBe(0xa5);
  });

  it('CMC toggles carry', () => {
    const cpu = makeCpu([0x3f]); // CMC
    cpu.flags.cy = true;
    cpu.step();
    expect(cpu.flags.cy).toBe(false);
  });

  it('STC sets carry', () => {
    const cpu = makeCpu([0x37]); // STC
    cpu.flags.cy = false;
    cpu.step();
    expect(cpu.flags.cy).toBe(true);
  });
});
