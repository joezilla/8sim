import type { IInterruptController } from '../interfaces/IInterruptController.js';

export class InterruptController implements IInterruptController {
  readonly id = 'pic';
  private pending = 0; // bitmask of pending IRQ lines
  private readonly lines: number;

  constructor(lines = 8) {
    this.lines = lines;
  }

  hasPendingInterrupt(): boolean {
    return this.pending !== 0;
  }

  acknowledge(): number {
    // Find lowest pending IRQ line
    for (let i = 0; i < this.lines; i++) {
      if ((this.pending & (1 << i)) !== 0) {
        this.pending &= ~(1 << i);
        // RST n instruction: 0b11_nnn_111
        return 0xc7 | (i << 3);
      }
    }
    return 0xff; // no interrupt (NOP)
  }

  assertIRQ(line: number): void {
    if (line >= 0 && line < this.lines) {
      this.pending |= 1 << line;
    }
  }

  clearIRQ(line: number): void {
    if (line >= 0 && line < this.lines) {
      this.pending &= ~(1 << line);
    }
  }

  reset(): void {
    this.pending = 0;
  }
}
