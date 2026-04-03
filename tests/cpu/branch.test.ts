import { describe, it, expect } from 'vitest';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';

function makeCpu(program: number[], baseOffset = 0): { cpu: Cpu8080; ram: Ram } {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0, 0x10000);
  ram.load(new Uint8Array(program), baseOffset);
  bus.attachMemory(ram);
  const cpu = new Cpu8080(bus, pic);
  cpu.registers.pc = baseOffset;
  return { cpu, ram };
}

describe('Branch instructions', () => {
  it('JMP sets PC unconditionally', () => {
    const { cpu } = makeCpu([0xc3, 0x00, 0x10]); // JMP 0x1000
    cpu.step();
    expect(cpu.registers.pc).toBe(0x1000);
  });

  it('JNZ jumps when Z=0', () => {
    const { cpu } = makeCpu([0xc2, 0x00, 0x10]); // JNZ 0x1000
    cpu.flags.z = false;
    cpu.step();
    expect(cpu.registers.pc).toBe(0x1000);
  });

  it('JNZ falls through when Z=1', () => {
    const { cpu } = makeCpu([0xc2, 0x00, 0x10]); // JNZ 0x1000
    cpu.flags.z = true;
    cpu.step();
    expect(cpu.registers.pc).toBe(3);
  });

  it('JZ jumps when Z=1', () => {
    const { cpu } = makeCpu([0xca, 0x00, 0x10]); // JZ 0x1000
    cpu.flags.z = true;
    cpu.step();
    expect(cpu.registers.pc).toBe(0x1000);
  });

  it('CALL pushes PC and jumps', () => {
    const { cpu } = makeCpu([0xcd, 0x00, 0x20]); // CALL 0x2000
    cpu.registers.sp = 0x1000;
    cpu.step();
    expect(cpu.registers.pc).toBe(0x2000);
    expect(cpu.registers.sp).toBe(0x0ffe);
  });

  it('RET pops PC from stack', () => {
    const { cpu, ram } = makeCpu([0xc9]); // RET
    cpu.registers.sp = 0x0ffe;
    ram.write(0x0ffe, 0x34);
    ram.write(0x0fff, 0x12);
    cpu.step();
    expect(cpu.registers.pc).toBe(0x1234);
    expect(cpu.registers.sp).toBe(0x1000);
  });

  it('CALL/RET round-trip', () => {
    // Program: CALL 0x0010; at 0x10: RET
    const mem = new Array(0x100).fill(0);
    mem[0] = 0xcd; mem[1] = 0x10; mem[2] = 0x00; // CALL 0x0010
    mem[0x10] = 0xc9; // RET
    const { cpu } = makeCpu(mem);
    cpu.registers.sp = 0x1000;
    cpu.step(); // CALL
    expect(cpu.registers.pc).toBe(0x10);
    cpu.step(); // RET
    expect(cpu.registers.pc).toBe(3); // back to instruction after CALL
  });

  it('RST 1 pushes PC and jumps to 0x0008', () => {
    const { cpu } = makeCpu([0xcf]); // RST 1
    cpu.registers.sp = 0x1000;
    cpu.step();
    expect(cpu.registers.pc).toBe(0x0008);
    expect(cpu.registers.sp).toBe(0x0ffe);
  });

  it('PCHL jumps to HL', () => {
    const { cpu } = makeCpu([0xe9]); // PCHL
    cpu.registers.hl = 0x5678;
    cpu.step();
    expect(cpu.registers.pc).toBe(0x5678);
  });
});
