import type { Z80Handler, Z80IndexedCbHandler, IndexView, Z80Core } from './types.js';
import { HL_VIEW, IX_VIEW, IY_VIEW, sext8 } from './views.js';
import { registerLoad } from './instructions/load.js';
import { registerExchange } from './instructions/exchange.js';
import { registerAlu8 } from './instructions/alu8.js';
import { registerAlu16 } from './instructions/alu16.js';
import { registerRotate } from './instructions/rotate.js';
import { registerJump } from './instructions/jump.js';
import { registerStack } from './instructions/stack.js';
import { registerIO } from './instructions/io.js';
import { registerControl } from './instructions/control.js';
import { registerBits } from './instructions/bits.js';
import { registerEd } from './instructions/ed.js';
import { registerBlock } from './instructions/block.js';

/** Build a 256-entry table pre-filled with a warn-on-execute stub. */
function makeTable(name: string): Z80Handler[] {
  return new Array<Z80Handler>(256).fill((_cpu) => 4).map((_, i) => {
    return (_cpu: Z80Core): number => {
      console.warn(`[Z80] Unimplemented ${name} opcode: 0x${i.toString(16).padStart(2, '0')}`);
      return 4;
    };
  });
}

function makeIdxCbTable(): Z80IndexedCbHandler[] {
  return new Array<Z80IndexedCbHandler>(256).fill((_c, _a) => 8).map((_, i) => {
    return (_cpu: Z80Core, _addr: number): number => {
      console.warn(`[Z80] Unimplemented DDCB opcode: 0x${i.toString(16).padStart(2, '0')}`);
      return 8;
    };
  });
}

/**
 * The Z80 opcode tables. `main`/`mainIX`/`mainIY` are the three views of the
 * unprefixed space; `cb` and `ed` are the CB- and ED-prefixed spaces; `idxCb`
 * holds the DDCB/FDCB bodies (address precomputed by the dispatcher, shared
 * between IX and IY).
 */
export class DecoderZ80 {
  readonly main: Z80Handler[] = makeTable('main');
  readonly mainIX: Z80Handler[] = makeTable('mainIX');
  readonly mainIY: Z80Handler[] = makeTable('mainIY');
  readonly cb: Z80Handler[] = makeTable('CB');
  readonly ed: Z80Handler[] = makeTable('ED');
  readonly idxCb: Z80IndexedCbHandler[] = makeIdxCbTable();

  constructor() {
    // Unassigned ED slots behave as NONI + NOP (8 T-states, no warning spam).
    for (let i = 0; i < 256; i++) {
      this.ed[i] = (_cpu) => 8;
    }

    // Build the three views of the main table.
    this.buildMain(this.main, HL_VIEW);
    this.buildMain(this.mainIX, IX_VIEW);
    this.buildMain(this.mainIY, IY_VIEW);

    // CB-prefixed space (shared) and its DDCB/FDCB bodies.
    registerBits(this.cb, this.idxCb);

    // ED-prefixed space (shared): misc + block ops.
    registerEd(this.ed);
    registerBlock(this.ed);

    // Wire the prefix dispatchers into each main table.
    this.wireCbDispatch();
    this.wireEdDispatch();
  }

  private buildMain(table: Z80Handler[], view: IndexView): void {
    registerLoad(table, view);
    registerExchange(table, view);
    registerAlu8(table, view);
    registerAlu16(table, view);
    registerRotate(table, view);
    registerJump(table, view);
    registerStack(table, view);
    registerIO(table, view);
    registerControl(table, view);
  }

  /**
   * main[0xCB]: plain CB dispatch (fetch op, R++, run cb table).
   * mainIX/IY[0xCB]: DDCB/FDCB dispatch — displacement fetched BEFORE the final
   * opcode, and that final byte is NOT an M1 fetch (only DD and CB tick R).
   */
  private wireCbDispatch(): void {
    this.main[0xcb] = (cpu) => {
      const op = cpu.fetchByte();
      cpu.regs.incR();
      return this.cb[op]!(cpu);
    };
    const idxDispatch = (getPair: (cpu: Z80Core) => number): Z80Handler => (cpu) => {
      const d = sext8(cpu.fetchByte());
      cpu.regs.incR(); // the CB prefix byte
      const addr = (getPair(cpu) + d) & 0xffff;
      cpu.regs.wz = addr;
      const op = cpu.fetchByte(); // final byte — not an M1 cycle
      return this.idxCb[op]!(cpu, addr);
    };
    this.mainIX[0xcb] = idxDispatch((cpu) => cpu.regs.ix);
    this.mainIY[0xcb] = idxDispatch((cpu) => cpu.regs.iy);
  }

  /** main/mainIX/mainIY[0xED]: identical ED dispatch (a DD/FD before ED is ignored). */
  private wireEdDispatch(): void {
    const dispatch: Z80Handler = (cpu) => {
      const op = cpu.fetchByte();
      cpu.regs.incR();
      return this.ed[op]!(cpu);
    };
    this.main[0xed] = dispatch;
    this.mainIX[0xed] = dispatch;
    this.mainIY[0xed] = dispatch;
  }
}
