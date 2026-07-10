import type { IBus } from '../../interfaces/IBus.js';
import type { ICpu } from '../../interfaces/ICpu.js';
import type { IInterruptController } from '../../interfaces/IInterruptController.js';
import type { Z80Core } from './types.js';
import { RegistersZ80 } from './RegistersZ80.js';
import { FlagsZ80 } from './FlagsZ80.js';
import { DecoderZ80 } from './DecoderZ80.js';
import { u16 } from '../../util/bits.js';

/**
 * Zilog Z80 CPU core. Fully implements the documented and undocumented
 * instruction set, IM 0/1/2 + NMI interrupts, and the shadow/index register file.
 *
 * Interrupt conventions (no change to {@link IInterruptController} required):
 *   - IM 0: the byte from `acknowledge()` is executed as an opcode. The stock
 *     controller returns a single-byte RST, which is the common real-world case.
 *   - IM 2: the `acknowledge()` byte is used as the low half of the vector-table
 *     pointer (`(I << 8) | ackByte`); the vector is read from memory.
 * A maskable interrupt is serviced only when IFF1 is set; NMI (via
 * {@link triggerNMI}) is always serviced and ignores IFF1.
 */
export class CpuZ80 implements ICpu, Z80Core {
  readonly regs = new RegistersZ80();
  readonly flags = new FlagsZ80();
  readonly bus: IBus;
  private readonly pic: IInterruptController;
  private readonly dec: DecoderZ80;

  iff1 = false;
  iff2 = false;
  im: 0 | 1 | 2 = 0;
  pendingEI = false;
  halted = false;
  private pendingNMI = false;

  constructor(bus: IBus, pic: IInterruptController) {
    this.bus = bus;
    this.pic = pic;
    this.dec = new DecoderZ80();
  }

  /** Program counter accessor (ICpu). */
  get pc(): number { return this.regs.pc; }
  set pc(v: number) { this.regs.pc = u16(v); }

  /** Assert a non-maskable interrupt (edge-triggered latch; serviced next step). */
  triggerNMI(): void {
    this.pendingNMI = true;
  }

  // --- Z80Core memory/stack helpers ---

  fetchByte(): number {
    const b = this.bus.read(this.regs.pc);
    this.regs.pc = u16(this.regs.pc + 1);
    return b;
  }

  fetchWord(): number {
    const lo = this.fetchByte();
    const hi = this.fetchByte();
    return (hi << 8) | lo;
  }

  push16(v: number): void {
    this.regs.sp = u16(this.regs.sp - 1);
    this.bus.write(this.regs.sp, (v >> 8) & 0xff);
    this.regs.sp = u16(this.regs.sp - 1);
    this.bus.write(this.regs.sp, v & 0xff);
  }

  pop16(): number {
    const lo = this.bus.read(this.regs.sp);
    this.regs.sp = u16(this.regs.sp + 1);
    const hi = this.bus.read(this.regs.sp);
    this.regs.sp = u16(this.regs.sp + 1);
    return (hi << 8) | lo;
  }

  reset(): void {
    this.regs.reset();
    this.flags.reset();
    this.iff1 = false;
    this.iff2 = false;
    this.im = 0;
    this.pendingEI = false;
    this.halted = false;
    this.pendingNMI = false;
  }

  step(): number {
    // 1. NMI has top priority; it wakes HALT and ignores IFF1.
    if (this.pendingNMI) return this.serviceNMI();

    // 2. Commit a pending EI: the instruction after EI is the first that can be
    //    interrupted, so remember whether the commit happened *this* step.
    const eiJustCommitted = this.pendingEI;
    if (this.pendingEI) {
      this.iff1 = true;
      this.iff2 = true;
      this.pendingEI = false;
    }

    // 3. Maskable interrupt (not on the very step EI committed).
    if (this.iff1 && !eiJustCommitted && this.pic.hasPendingInterrupt()) {
      return this.serviceINT();
    }

    // 4. HALT executes internal NOPs; refresh keeps ticking.
    if (this.halted) {
      this.regs.incR();
      return 4;
    }

    // 5. Fetch opcode, absorbing any DD/FD prefix chain.
    let op = this.fetchByte();
    this.regs.incR();
    let table = this.dec.main;
    let prefixT = 0;
    while (op === 0xdd || op === 0xfd) {
      table = op === 0xdd ? this.dec.mainIX : this.dec.mainIY;
      prefixT += 4;
      op = this.fetchByte();
      this.regs.incR();
    }
    return prefixT + table[op]!(this);
  }

  private serviceINT(): number {
    this.iff1 = false;
    this.iff2 = false;
    this.halted = false;
    this.regs.incR();
    const ackByte = this.bus.acknowledgeInterrupt();
    switch (this.im) {
      case 0: {
        // Execute the ack byte as an opcode (PC not advanced for this fetch).
        // The stock controller returns a single-byte RST n.
        return 2 + this.dec.main[ackByte & 0xff]!(this);
      }
      case 1:
        this.push16(this.regs.pc);
        this.regs.pc = 0x0038;
        this.regs.wz = 0x0038;
        return 13;
      case 2: {
        const vector = ((this.regs.i << 8) | (ackByte & 0xff)) & 0xffff;
        this.push16(this.regs.pc);
        const lo = this.bus.read(vector);
        const hi = this.bus.read(u16(vector + 1));
        this.regs.pc = (hi << 8) | lo;
        this.regs.wz = this.regs.pc;
        return 19;
      }
    }
  }

  private serviceNMI(): number {
    this.pendingNMI = false;
    this.halted = false;
    this.iff1 = false; // IFF2 preserved so RETN can restore IFF1
    this.regs.incR();
    this.push16(this.regs.pc);
    this.regs.pc = 0x0066;
    this.regs.wz = 0x0066;
    return 11;
  }

  /** Run until halted or `maxCycles` T-states elapse; returns total T-states. */
  run(maxCycles = Infinity): bigint {
    let total = 0n;
    while (!this.halted && total < BigInt(maxCycles)) {
      total += BigInt(this.step());
    }
    return total;
  }
}
