import type { Z80Handler, IndexView } from '../types.js';
import type { FlagsZ80 } from '../FlagsZ80.js';

/**
 * Accumulator rotates RLCA/RRCA/RLA/RRA (0x07/0x0F/0x17/0x1F).
 * Unlike the CB-prefixed rotates, these affect only H, N, C, and the
 * undocumented X/Y (copied from the new A); S, Z, PV are left untouched.
 * Not view-dependent, but they live in the main table so are registered per view.
 */
export function registerRotate(table: Z80Handler[], _view: IndexView): void {
  const finish = (f: FlagsZ80, a: number, carry: number): void => {
    f.c = carry !== 0;
    f.h = false;
    f.n = false;
    f.y = (a & 0x20) !== 0;
    f.x = (a & 0x08) !== 0;
  };

  // RLCA
  table[0x07] = (cpu) => {
    const a = cpu.regs.a;
    const c = (a >> 7) & 1;
    cpu.regs.a = ((a << 1) | c) & 0xff;
    finish(cpu.flags, cpu.regs.a, c);
    return 4;
  };

  // RRCA
  table[0x0f] = (cpu) => {
    const a = cpu.regs.a;
    const c = a & 1;
    cpu.regs.a = ((a >> 1) | (c << 7)) & 0xff;
    finish(cpu.flags, cpu.regs.a, c);
    return 4;
  };

  // RLA (rotate left through carry)
  table[0x17] = (cpu) => {
    const a = cpu.regs.a;
    const c = (a >> 7) & 1;
    cpu.regs.a = ((a << 1) | (cpu.flags.c ? 1 : 0)) & 0xff;
    finish(cpu.flags, cpu.regs.a, c);
    return 4;
  };

  // RRA (rotate right through carry)
  table[0x1f] = (cpu) => {
    const a = cpu.regs.a;
    const c = a & 1;
    cpu.regs.a = ((a >> 1) | (cpu.flags.c ? 0x80 : 0)) & 0xff;
    finish(cpu.flags, cpu.regs.a, c);
    return 4;
  };
}
