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
  return { cpu, ram };
}

describe('Data movement instructions', () => {
  describe('MOV', () => {
    it('MOV B,C copies C to B', () => {
      const { cpu } = makeCpu([0x41]); // MOV B,C
      cpu.registers.c = 0x42;
      cpu.step();
      expect(cpu.registers.b).toBe(0x42);
    });

    it('MOV A,M reads from memory', () => {
      const { cpu, ram } = makeCpu([0x7e]); // MOV A,M
      cpu.registers.hl = 0x100;
      ram.write(0x100, 0xab);
      cpu.step();
      expect(cpu.registers.a).toBe(0xab);
    });

    it('MOV M,A writes A to memory', () => {
      const { cpu, ram } = makeCpu([0x77]); // MOV M,A
      cpu.registers.a = 0xcd;
      cpu.registers.hl = 0x200;
      cpu.step();
      expect(ram.read(0x200)).toBe(0xcd);
    });
  });

  describe('MVI', () => {
    it('MVI B,d8 loads immediate to B', () => {
      const { cpu } = makeCpu([0x06, 0x55]); // MVI B,0x55
      cpu.step();
      expect(cpu.registers.b).toBe(0x55);
    });

    it('MVI M,d8 stores immediate to memory', () => {
      const { cpu, ram } = makeCpu([0x36, 0x77]); // MVI M,0x77
      cpu.registers.hl = 0x300;
      cpu.step();
      expect(ram.read(0x300)).toBe(0x77);
    });
  });

  describe('LXI', () => {
    it('LXI B loads BC from immediate', () => {
      const { cpu } = makeCpu([0x01, 0x34, 0x12]); // LXI B,0x1234
      cpu.step();
      expect(cpu.registers.bc).toBe(0x1234);
    });

    it('LXI SP loads stack pointer', () => {
      const { cpu } = makeCpu([0x31, 0x00, 0x20]); // LXI SP,0x2000
      cpu.step();
      expect(cpu.registers.sp).toBe(0x2000);
    });
  });

  describe('LDA/STA', () => {
    it('LDA loads from direct address', () => {
      const { cpu, ram } = makeCpu([0x3a, 0x00, 0x10]); // LDA 0x1000
      ram.write(0x1000, 0xbe);
      cpu.step();
      expect(cpu.registers.a).toBe(0xbe);
    });

    it('STA stores to direct address', () => {
      const { cpu, ram } = makeCpu([0x32, 0x00, 0x10]); // STA 0x1000
      cpu.registers.a = 0xef;
      cpu.step();
      expect(ram.read(0x1000)).toBe(0xef);
    });
  });

  describe('LHLD/SHLD', () => {
    it('LHLD loads HL from memory', () => {
      const { cpu, ram } = makeCpu([0x2a, 0x00, 0x10]); // LHLD 0x1000
      ram.write(0x1000, 0x34);
      ram.write(0x1001, 0x12);
      cpu.step();
      expect(cpu.registers.hl).toBe(0x1234);
    });

    it('SHLD stores HL to memory', () => {
      const { cpu, ram } = makeCpu([0x22, 0x00, 0x10]); // SHLD 0x1000
      cpu.registers.hl = 0xabcd;
      cpu.step();
      expect(ram.read(0x1000)).toBe(0xcd); // L first
      expect(ram.read(0x1001)).toBe(0xab); // H second
    });
  });

  describe('XCHG', () => {
    it('exchanges HL and DE', () => {
      const { cpu } = makeCpu([0xeb]); // XCHG
      cpu.registers.hl = 0x1234;
      cpu.registers.de = 0x5678;
      cpu.step();
      expect(cpu.registers.hl).toBe(0x5678);
      expect(cpu.registers.de).toBe(0x1234);
    });
  });

  describe('LDAX/STAX', () => {
    it('LDAX D loads A from address in DE', () => {
      const { cpu, ram } = makeCpu([0x1a]); // LDAX D
      cpu.registers.de = 0x400;
      ram.write(0x400, 0x99);
      cpu.step();
      expect(cpu.registers.a).toBe(0x99);
    });

    it('STAX B stores A to address in BC', () => {
      const { cpu, ram } = makeCpu([0x02]); // STAX B
      cpu.registers.bc = 0x500;
      cpu.registers.a = 0x11;
      cpu.step();
      expect(ram.read(0x500)).toBe(0x11);
    });
  });
});
