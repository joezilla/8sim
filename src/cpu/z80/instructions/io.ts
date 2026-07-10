import type { Z80Handler, IndexView } from '../types.js';

/**
 * Main-table I/O: IN A,(n) and OUT (n),A. The ED-prefixed IN r,(C)/OUT (C),r
 * and the block I/O ops live in ed.ts / block.ts. Ports are addressed by the
 * low 8 bits to match the emulator's 8-bit IoSpace.
 */
export function registerIO(table: Z80Handler[], _view: IndexView): void {
  // IN A,(n) — WZ = (A<<8 | n) + 1
  table[0xdb] = (cpu) => {
    const n = cpu.fetchByte();
    cpu.regs.wz = (((cpu.regs.a << 8) | n) + 1) & 0xffff;
    cpu.regs.a = cpu.bus.ioRead(n) & 0xff;
    return 11;
  };

  // OUT (n),A — WZ low = (n+1)&0xff, WZ high = A
  table[0xd3] = (cpu) => {
    const n = cpu.fetchByte();
    cpu.bus.ioWrite(n, cpu.regs.a);
    cpu.regs.wz = ((cpu.regs.a << 8) | ((n + 1) & 0xff)) & 0xffff;
    return 11;
  };
}
