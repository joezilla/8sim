import type { Decoder } from '../Decoder.js';

export function registerControl(decoder: Decoder): void {
  // NOP
  decoder.register(0x00, (_regs, _flags, _bus) => 4);

  // HLT — CPU halts; handled specially in Cpu8080.step(), but we register it
  // The Cpu8080 checks for HLT before decoding so this is a fallback
  decoder.register(0x76, (_regs, _flags, _bus) => 7);

  // EI — handled in Cpu8080.step() via pendingEI flag
  decoder.register(0xfb, (_regs, _flags, _bus) => 4);

  // DI — handled in Cpu8080.step()
  decoder.register(0xf3, (_regs, _flags, _bus) => 4);
}
