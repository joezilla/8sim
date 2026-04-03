import type { IBus } from '../interfaces/IBus.js';
import type { Registers } from './Registers.js';
import type { Flags } from './Flags.js';

export type InstructionHandler = (regs: Registers, flags: Flags, bus: IBus) => number;

export class Decoder {
  private table: InstructionHandler[];

  constructor() {
    this.table = new Array(256).fill(undefined).map((_, i) => {
      return (_regs: Registers, _flags: Flags, _bus: IBus): number => {
        console.warn(`Unimplemented opcode: 0x${i.toString(16).padStart(2, '0')}`);
        return 4;
      };
    });
  }

  register(opcode: number, handler: InstructionHandler): void {
    this.table[opcode] = handler;
  }

  registerMany(opcodes: number[], handler: InstructionHandler): void {
    for (const op of opcodes) {
      this.register(op, handler);
    }
  }

  decode(opcode: number): InstructionHandler {
    return this.table[opcode & 0xff]!;
  }
}
