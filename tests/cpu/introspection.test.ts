import { describe, it, expect } from 'vitest';
import { buildMachine } from '../../src/machine/buildMachine.js';

/** Front-panel introspection surface (Bitsby8 cockpit Phase 3): a running
 * machine exposes CPU state, a settable PC, bus examine/deposit, and pause/step
 * — all without new 8sim wiring beyond the uniform cpu.state() snapshot. */
describe('CPU introspection for the front panel', () => {
  function machine(cpuKind: 'i8080' | 'z80') {
    return buildMachine({
      cpuKind,
      clock: 'max',
      resetVector: 0xf800,
      // MVI A,0x42 ; NOP  at 0xF800
      memory: [
        { id: 'ram', base: 0, size: 0xf800, kind: 'ram' },
        { id: 'rom', base: 0xf800, size: 4, kind: 'rom', image: new Uint8Array([0x3e, 0x42, 0x00, 0x76]) },
      ],
      cards: [],
    });
  }

  it('cpu.state() reflects PC/registers/halted, uniformly for 8080 and Z80', () => {
    for (const kind of ['i8080', 'z80'] as const) {
      const m = machine(kind);
      expect(m.cpu.state().pc).toBe(0xf800); // reset vector
      expect(m.cpu.state().halted).toBe(false);
      m.cpu.step(); // MVI A,0x42
      const s = m.cpu.state();
      expect(s.a).toBe(0x42);
      expect(s.pc).toBe(0xf802);
      expect(typeof s.f).toBe('number');
    }
  });

  it('examine/deposit via the bus, and set PC (GO)', () => {
    const m = machine('i8080');
    // examine: read a ROM byte
    expect(m.bus.read(0xf801)).toBe(0x42);
    // deposit into RAM, read it back
    m.bus.write(0x1234, 0xab);
    expect(m.bus.read(0x1234)).toBe(0xab);
    // GO: set PC (front-panel EXAMINE/GO)
    m.cpu.pc = 0x1000;
    expect(m.cpu.state().pc).toBe(0x1000);
  });

  it('the runner exposes its running state (pause/step is stop + cpu.step)', () => {
    const m = machine('i8080');
    expect(m.runner.isRunning).toBe(false);
    m.runner.start();
    expect(m.runner.isRunning).toBe(true);
    m.runner.stop();
    expect(m.runner.isRunning).toBe(false);
    // single-step while paused
    const before = m.cpu.state().pc;
    m.cpu.step();
    expect(m.cpu.state().pc).not.toBe(before);
  });
});
