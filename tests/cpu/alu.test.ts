import { describe, it, expect, beforeEach } from 'vitest';
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
  return { cpu, ram };
}

describe('ALU instructions', () => {
  describe('ADD', () => {
    it('adds register to A', () => {
      const { cpu } = makeCpu([0x80]); // ADD B
      cpu.registers.a = 5;
      cpu.registers.b = 3;
      const cycles = cpu.step();
      expect(cpu.registers.a).toBe(8);
      expect(cycles).toBe(4);
    });

    it('sets carry on overflow', () => {
      const { cpu } = makeCpu([0x80]); // ADD B
      cpu.registers.a = 0xff;
      cpu.registers.b = 1;
      cpu.step();
      expect(cpu.registers.a).toBe(0);
      expect(cpu.flags.cy).toBe(true);
      expect(cpu.flags.z).toBe(true);
    });

    it('sets sign flag', () => {
      const { cpu } = makeCpu([0x80]); // ADD B
      cpu.registers.a = 0x7f;
      cpu.registers.b = 1;
      cpu.step();
      expect(cpu.flags.s).toBe(true);
    });

    it('ADI immediate', () => {
      const { cpu } = makeCpu([0xc6, 0x10]); // ADI 0x10
      cpu.registers.a = 0x20;
      cpu.step();
      expect(cpu.registers.a).toBe(0x30);
    });
  });

  describe('SUB', () => {
    it('subtracts register from A', () => {
      const { cpu } = makeCpu([0x90]); // SUB B
      cpu.registers.a = 10;
      cpu.registers.b = 3;
      cpu.step();
      expect(cpu.registers.a).toBe(7);
      expect(cpu.flags.cy).toBe(false);
    });

    it('sets carry on borrow', () => {
      const { cpu } = makeCpu([0x90]); // SUB B
      cpu.registers.a = 3;
      cpu.registers.b = 5;
      cpu.step();
      expect(cpu.flags.cy).toBe(true);
    });
  });

  describe('INR/DCR', () => {
    it('INR increments register', () => {
      const { cpu } = makeCpu([0x04]); // INR B
      cpu.registers.b = 0;
      cpu.step();
      expect(cpu.registers.b).toBe(1);
    });

    it('INR does not affect carry', () => {
      const { cpu } = makeCpu([0x3c]); // INR A
      cpu.registers.a = 0xff;
      cpu.flags.cy = false;
      cpu.step();
      expect(cpu.registers.a).toBe(0);
      expect(cpu.flags.cy).toBe(false); // CY unaffected
      expect(cpu.flags.z).toBe(true);
    });

    it('DCR decrements register', () => {
      const { cpu } = makeCpu([0x05]); // DCR B
      cpu.registers.b = 5;
      cpu.step();
      expect(cpu.registers.b).toBe(4);
    });
  });

  describe('DAD', () => {
    it('adds BC to HL', () => {
      const { cpu } = makeCpu([0x09]); // DAD B
      cpu.registers.hl = 0x1234;
      cpu.registers.bc = 0x0100;
      cpu.step();
      expect(cpu.registers.hl).toBe(0x1334);
      expect(cpu.flags.cy).toBe(false);
    });

    it('sets carry on 16-bit overflow', () => {
      const { cpu } = makeCpu([0x09]); // DAD B
      cpu.registers.hl = 0xffff;
      cpu.registers.bc = 0x0001;
      cpu.step();
      expect(cpu.registers.hl).toBe(0);
      expect(cpu.flags.cy).toBe(true);
    });
  });

  describe('INX/DCX', () => {
    it('INX B increments BC', () => {
      const { cpu } = makeCpu([0x03]); // INX B
      cpu.registers.bc = 0x00ff;
      cpu.step();
      expect(cpu.registers.bc).toBe(0x0100);
    });

    it('DCX D decrements DE', () => {
      const { cpu } = makeCpu([0x1b]); // DCX D
      cpu.registers.de = 0x0100;
      cpu.step();
      expect(cpu.registers.de).toBe(0x00ff);
    });
  });

  describe('ADC/SBB', () => {
    it('ADC adds with carry', () => {
      const { cpu } = makeCpu([0x88]); // ADC B
      cpu.registers.a = 5;
      cpu.registers.b = 3;
      cpu.flags.cy = true;
      cpu.step();
      expect(cpu.registers.a).toBe(9);
    });

    it('SBB subtracts with borrow', () => {
      const { cpu } = makeCpu([0x98]); // SBB B
      cpu.registers.a = 10;
      cpu.registers.b = 3;
      cpu.flags.cy = true;
      cpu.step();
      expect(cpu.registers.a).toBe(6);
    });
  });
});
