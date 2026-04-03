import type { IBus } from '../interfaces/IBus.js';
import type { IInterruptController } from '../interfaces/IInterruptController.js';
import { Registers } from './Registers.js';
import { Flags } from './Flags.js';
import { Decoder } from './Decoder.js';
import { registerControl } from './instructions/control.js';
import { registerData } from './instructions/data.js';
import { registerAlu } from './instructions/alu.js';
import { registerLogical } from './instructions/logical.js';
import { registerRotate } from './instructions/rotate.js';
import { registerBranch } from './instructions/branch.js';
import { registerStack } from './instructions/stack.js';
import { registerIO } from './instructions/io.js';
import { u16 } from '../util/bits.js';

export class Cpu8080 {
  readonly registers: Registers;
  readonly flags: Flags;
  private bus: IBus;
  private pic: IInterruptController;
  private decoder: Decoder;

  inte = false;
  pendingEI = false;
  halted = false;

  constructor(bus: IBus, pic: IInterruptController) {
    this.bus = bus;
    this.pic = pic;
    this.registers = new Registers();
    this.flags = new Flags();
    this.decoder = new Decoder();
    this.buildDecoder();
  }

  private buildDecoder(): void {
    registerControl(this.decoder);
    registerData(this.decoder);
    registerAlu(this.decoder);
    registerLogical(this.decoder);
    registerRotate(this.decoder);
    registerBranch(this.decoder);
    registerStack(this.decoder);
    registerIO(this.decoder);
  }

  reset(): void {
    this.registers.reset();
    this.flags.reset();
    this.inte = false;
    this.pendingEI = false;
    this.halted = false;
  }

  step(): number {
    const regs = this.registers;

    // Handle halted state
    if (this.halted) {
      if (this.inte && this.pic.hasPendingInterrupt()) {
        this.handleInterrupt();
        return 11;
      }
      return 4;
    }

    // Commit pendingEI: the instruction after EI is the first that can be interrupted
    if (this.pendingEI) {
      this.inte = true;
      this.pendingEI = false;
    }

    // Check for interrupt
    if (this.inte && this.pic.hasPendingInterrupt()) {
      this.handleInterrupt();
      return 11;
    }

    const opcode = this.bus.read(regs.pc);
    regs.pc = u16(regs.pc + 1);

    // Handle special opcodes inline
    if (opcode === 0x76) { // HLT
      this.halted = true;
      return 7;
    }
    if (opcode === 0xfb) { // EI
      this.pendingEI = true;
      return 4;
    }
    if (opcode === 0xf3) { // DI
      this.inte = false;
      this.pendingEI = false;
      return 4;
    }

    const handler = this.decoder.decode(opcode);
    return handler(regs, this.flags, this.bus);
  }

  private handleInterrupt(): void {
    this.inte = false;
    this.halted = false;
    const rstByte = this.bus.acknowledgeInterrupt();
    const regs = this.registers;
    // Push current PC
    regs.sp = u16(regs.sp - 1);
    this.bus.write(regs.sp, (regs.pc >> 8) & 0xff);
    regs.sp = u16(regs.sp - 1);
    this.bus.write(regs.sp, regs.pc & 0xff);
    // Jump to RST vector
    regs.pc = (rstByte & 0x38);
  }

  /**
   * Run until halted or maxCycles exceeded.
   * Returns total T-states executed.
   */
  run(maxCycles = Infinity): bigint {
    let total = 0n;
    while (!this.halted && total < BigInt(maxCycles)) {
      total += BigInt(this.step());
    }
    return total;
  }
}
