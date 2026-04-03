import { describe, it, expect } from 'vitest';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';

function makeSystem(): { cpu: Cpu8080; ram: Ram; pic: InterruptController; bus: Bus } {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0, 0x10000);
  bus.attachMemory(ram);
  const cpu = new Cpu8080(bus, pic);
  cpu.registers.sp = 0x1000;
  return { cpu, ram, pic, bus };
}

describe('Interrupt handling', () => {
  it('interrupt not taken when INTE is false', () => {
    const { cpu, ram, pic } = makeSystem();
    ram.load(new Uint8Array([0x00, 0x00])); // NOP NOP
    cpu.inte = false;
    pic.assertIRQ(1);
    cpu.step(); // NOP - interrupt should not fire
    expect(cpu.registers.pc).toBe(1);
  });

  it('interrupt fires when INTE is true', () => {
    const { cpu, ram, pic } = makeSystem();
    ram.load(new Uint8Array([0x00])); // NOP at 0
    cpu.inte = true;
    pic.assertIRQ(1); // RST 1 → vector 0x0008
    cpu.step(); // interrupt taken
    expect(cpu.registers.pc).toBe(0x0008);
    expect(cpu.inte).toBe(false);
  });

  it('EI sets pendingEI, interrupt fires after next instruction', () => {
    const { cpu, ram, pic } = makeSystem();
    // 0: EI (0xFB), 1: NOP (0x00), 2: NOP ...
    ram.load(new Uint8Array([0xfb, 0x00, 0x00]));
    pic.assertIRQ(2); // RST 2 → 0x0010

    cpu.step(); // EI — sets pendingEI, interrupt NOT taken yet
    expect(cpu.registers.pc).toBe(1);
    expect(cpu.inte).toBe(false);
    expect(cpu.pendingEI).toBe(true);

    cpu.step(); // NOP — inte becomes true at start, then interrupt fires
    expect(cpu.registers.pc).toBe(0x0010);
  });

  it('DI disables interrupts', () => {
    const { cpu, ram, pic } = makeSystem();
    ram.load(new Uint8Array([0xf3, 0x00])); // DI, NOP
    cpu.inte = true;
    cpu.step(); // DI — clears INTE before any IRQ is asserted
    expect(cpu.inte).toBe(false);
    pic.assertIRQ(0); // IRQ arrives after DI already disabled interrupts
    cpu.step(); // NOP — should not take interrupt
    expect(cpu.registers.pc).toBe(2);
  });

  it('HLT halts, resumes on interrupt', () => {
    const { cpu, ram, pic } = makeSystem();
    ram.load(new Uint8Array([0x76])); // HLT
    cpu.step(); // executes HLT
    expect(cpu.halted).toBe(true);

    cpu.inte = true;
    pic.assertIRQ(3); // RST 3 → 0x0018
    cpu.step(); // wake from HALT
    expect(cpu.halted).toBe(false);
    expect(cpu.registers.pc).toBe(0x0018);
  });

  it('RST byte encodes vector correctly', () => {
    const { cpu, ram, pic } = makeSystem();
    ram.load(new Uint8Array([0x00]));
    cpu.inte = true;
    pic.assertIRQ(7); // RST 7 → 0x0038
    cpu.step();
    expect(cpu.registers.pc).toBe(0x0038);
  });

  it('interrupt pushes correct return address', () => {
    const { cpu, ram, pic } = makeSystem();
    ram.load(new Uint8Array([0x00, 0x00, 0x00])); // NOPs
    cpu.registers.pc = 2;
    cpu.inte = true;
    pic.assertIRQ(0);
    cpu.step();
    // SP should point to pushed return addr = 2
    const lo = ram.read(cpu.registers.sp);
    const hi = ram.read(cpu.registers.sp + 1);
    expect((hi << 8) | lo).toBe(2);
  });
});
