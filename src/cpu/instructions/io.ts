import type { Decoder } from '../Decoder.js';
import { u16 } from '../../util/bits.js';

export function registerIO(decoder: Decoder): void {
  // IN port (0xDB)
  decoder.register(0xdb, (regs, _flags, bus) => {
    const port = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    regs.a = bus.ioRead(port);
    return 10;
  });

  // OUT port (0xD3)
  decoder.register(0xd3, (regs, _flags, bus) => {
    const port = bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);
    bus.ioWrite(port, regs.a);
    return 10;
  });
}
