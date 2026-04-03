import type { Decoder } from '../Decoder.js';
import { u8 } from '../../util/bits.js';

export function registerRotate(decoder: Decoder): void {
  // RLC (0x07) — Rotate A left; CY = bit7
  decoder.register(0x07, (regs, flags, _bus) => {
    const a = regs.a;
    flags.cy = (a & 0x80) !== 0;
    regs.a = u8((a << 1) | (flags.cy ? 1 : 0));
    return 4;
  });

  // RRC (0x0F) — Rotate A right; CY = bit0
  decoder.register(0x0f, (regs, flags, _bus) => {
    const a = regs.a;
    flags.cy = (a & 0x01) !== 0;
    regs.a = u8((a >> 1) | (flags.cy ? 0x80 : 0));
    return 4;
  });

  // RAL (0x17) — Rotate A left through carry
  decoder.register(0x17, (regs, flags, _bus) => {
    const a = regs.a;
    const newCY = (a & 0x80) !== 0;
    regs.a = u8((a << 1) | (flags.cy ? 1 : 0));
    flags.cy = newCY;
    return 4;
  });

  // RAR (0x1F) — Rotate A right through carry
  decoder.register(0x1f, (regs, flags, _bus) => {
    const a = regs.a;
    const newCY = (a & 0x01) !== 0;
    regs.a = u8((a >> 1) | (flags.cy ? 0x80 : 0));
    flags.cy = newCY;
    return 4;
  });
}
