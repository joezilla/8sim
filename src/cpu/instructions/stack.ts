import type { Decoder } from '../Decoder.js';
import { u16, toWord } from '../../util/bits.js';

export function registerStack(decoder: Decoder): void {
  // PUSH B (0xC5)
  decoder.register(0xc5, (regs, _flags, bus) => {
    regs.sp = u16(regs.sp - 1); bus.write(regs.sp, regs.b);
    regs.sp = u16(regs.sp - 1); bus.write(regs.sp, regs.c);
    return 11;
  });

  // PUSH D (0xD5)
  decoder.register(0xd5, (regs, _flags, bus) => {
    regs.sp = u16(regs.sp - 1); bus.write(regs.sp, regs.d);
    regs.sp = u16(regs.sp - 1); bus.write(regs.sp, regs.e);
    return 11;
  });

  // PUSH H (0xE5)
  decoder.register(0xe5, (regs, _flags, bus) => {
    regs.sp = u16(regs.sp - 1); bus.write(regs.sp, regs.h);
    regs.sp = u16(regs.sp - 1); bus.write(regs.sp, regs.l);
    return 11;
  });

  // PUSH PSW (0xF5) — A and Flags
  decoder.register(0xf5, (regs, flags, bus) => {
    regs.sp = u16(regs.sp - 1); bus.write(regs.sp, regs.a);
    regs.sp = u16(regs.sp - 1); bus.write(regs.sp, flags.toByte());
    return 11;
  });

  // POP B (0xC1)
  decoder.register(0xc1, (regs, _flags, bus) => {
    regs.c = bus.read(regs.sp); regs.sp = u16(regs.sp + 1);
    regs.b = bus.read(regs.sp); regs.sp = u16(regs.sp + 1);
    return 10;
  });

  // POP D (0xD1)
  decoder.register(0xd1, (regs, _flags, bus) => {
    regs.e = bus.read(regs.sp); regs.sp = u16(regs.sp + 1);
    regs.d = bus.read(regs.sp); regs.sp = u16(regs.sp + 1);
    return 10;
  });

  // POP H (0xE1)
  decoder.register(0xe1, (regs, _flags, bus) => {
    regs.l = bus.read(regs.sp); regs.sp = u16(regs.sp + 1);
    regs.h = bus.read(regs.sp); regs.sp = u16(regs.sp + 1);
    return 10;
  });

  // POP PSW (0xF1) — A and Flags
  decoder.register(0xf1, (regs, flags, bus) => {
    const psw = bus.read(regs.sp); regs.sp = u16(regs.sp + 1);
    regs.a  = bus.read(regs.sp); regs.sp = u16(regs.sp + 1);
    flags.fromByte(psw);
    return 10;
  });

  // XTHL (0xE3) — Exchange top of stack with HL
  decoder.register(0xe3, (regs, _flags, bus) => {
    const lo = bus.read(regs.sp);
    const hi = bus.read(u16(regs.sp + 1));
    bus.write(regs.sp, regs.l);
    bus.write(u16(regs.sp + 1), regs.h);
    regs.l = lo;
    regs.h = hi;
    return 18;
  });

  // SPHL (0xF9) — SP = HL
  decoder.register(0xf9, (regs, _flags, _bus) => {
    regs.sp = regs.hl;
    return 5;
  });
}
