/**
 * Synthetic firmware "stub ROM" for the IMSAI MDC-DIO card (Story 5.11).
 *
 * The genuine MDC-DIO carries a 2 KB 2716 firmware ROM whose entry points are
 * `CALL`ed with a command byte in A, returning a status byte in A. 8sim emulates
 * the firmware's *behavior* in TypeScript, so this ROM only needs to shuttle A
 * to/from the card and return — it never touches real drive hardware.
 *
 * The mechanism (see the plan's architecture spine): a memory-mapped device
 * sees only bus reads/writes, never CPU registers, and cannot force a RET. So
 * each entry point is a few hand-assembled 8080 instructions that
 *   1. STA <trap>   — writes A to a trap address the device observes; the write
 *                     starts the operation and the device latches a status.
 *   2. poll: LDA <trap> / ORA A / JZ poll  — the status byte is 0 while the
 *                     operation is pending and non-zero on completion (matching
 *                     the manual). Polling here lets an async backend (fdcplus
 *                     over WebSocket) resolve between MachineRunner batches.
 *   3. RET          — returns to the caller with the status in A.
 *
 * The boot entries additionally `JMP 0000` after their DMA completes (the
 * front-panel "EXAMINE E000, RUN" flow), so the vectors at E000/E003 read C3 —
 * exactly what the manual says the data lights should show.
 */

/** Region-relative trap offsets (into a E000-based window). Chosen inside the
 * manual's "EB01-ECFF undefined" range so they never alias a real firmware
 * address. WRITE = command byte in A; READ = latched status byte. */
export const TRAP_CMD_STD = 0xc00;
export const TRAP_CMD_MINI = 0xc01;
export const TRAP_INIT = 0xc02;
export const TRAP_BOOT_STD = 0xc03;
export const TRAP_BOOT_MINI = 0xc04;

/** Entry-point offsets (region-relative); front panel EXAMINEs E000/E003. */
export const ENTRY = {
  bootStd: 0x000,
  bootMini: 0x003,
  cmdStd: 0x006,
  cmdMini: 0x009,
  init: 0x00c,
} as const;

/** Bytes of ROM window (E000-E7FF). */
export const STUB_ROM_SIZE = 0x800;

// 8080 opcodes used below.
const OP_JMP = 0xc3;
const OP_STA = 0x32;
const OP_LDA = 0x3a;
const OP_ORA_A = 0xb7;
const OP_JZ = 0xca;
const OP_RET = 0xc9;
const OP_MVI_A = 0x3e;

/**
 * Assemble the stub ROM. Returns a {@link STUB_ROM_SIZE}-byte image, 0xFF-filled
 * except for the vectors and handlers. `baseAddress` is the window's base (the
 * traps live at `baseAddress + 0xC0x`), so a relocated window still targets its
 * own registers.
 */
export function buildStubRom(baseAddress = 0xe000): Uint8Array {
  const rom = new Uint8Array(STUB_ROM_SIZE).fill(0xff);
  const base = baseAddress & 0xffff;

  // Tiny cursor-based emitter working in absolute addresses; rom is indexed by
  // (pc - base). Handlers use absolute STA/LDA/JZ/JMP targets.
  let pc = base;
  const put = (b: number): void => { rom[pc - base] = b & 0xff; pc++; };
  const word = (addr: number): void => { put(addr & 0xff); put((addr >> 8) & 0xff); };
  const jmp = (addr: number): void => { put(OP_JMP); word(addr); };
  const sta = (addr: number): void => { put(OP_STA); word(addr); };
  const lda = (addr: number): void => { put(OP_LDA); word(addr); };
  const jz = (addr: number): void => { put(OP_JZ); word(addr); };
  const mviA = (d: number): void => { put(OP_MVI_A); put(d & 0xff); };

  /** command/init handler: STA trap; poll: LDA trap; ORA A; JZ poll; RET. */
  const emitCommand = (trap: number): number => {
    const entry = pc;
    sta(base + trap);
    const poll = pc;
    lda(base + trap);
    put(OP_ORA_A);
    jz(poll);
    put(OP_RET);
    return entry;
  };

  /** boot handler: MVI A,0; STA trap; wait: LDA trap; ORA A; JZ wait; JMP 0000. */
  const emitBoot = (trap: number): number => {
    const entry = pc;
    mviA(0);
    sta(base + trap);
    const wait = pc;
    lda(base + trap);
    put(OP_ORA_A);
    jz(wait);
    jmp(0x0000);
    return entry;
  };

  // Lay the handlers down after the 15-byte vector table (E000-E00E), starting
  // at offset 0x10 (E00F is a pad byte).
  pc = base + 0x10;
  const cmdStd = emitCommand(TRAP_CMD_STD);
  const cmdMini = emitCommand(TRAP_CMD_MINI);
  const init = emitCommand(TRAP_INIT);
  const bootStd = emitBoot(TRAP_BOOT_STD);
  const bootMini = emitBoot(TRAP_BOOT_MINI);

  // Fill the five entry-point vectors (order fixed by the manual).
  pc = base + ENTRY.bootStd; jmp(bootStd);
  pc = base + ENTRY.bootMini; jmp(bootMini);
  pc = base + ENTRY.cmdStd; jmp(cmdStd);
  pc = base + ENTRY.cmdMini; jmp(cmdMini);
  pc = base + ENTRY.init; jmp(init);

  return rom;
}
