/**
 * 8080 status word (Bitsby8 cockpit front panel).
 *
 * At the start of every machine cycle the 8080 emits a status byte on the data
 * bus (latched by the 8228 at SYNC); the Altair front panel wires eight of these
 * to lamps. 8sim executes a whole instruction per `step()`, so there is no single
 * live machine cycle to reflect — instead we characterize the instruction from
 * its opcode into one representative status byte. That's exactly what a debugger
 * single-stepping wants: after each step the lamps show what that instruction
 * did (fetch, memory read/write, IN/OUT, stack, halt).
 *
 * `WO` is active-low on real hardware (1 = read cycle, 0 = write); we keep that
 * convention so the panel's WO lamp lights on reads, as on the Altair.
 */
export const STATUS = {
  INTA: 0x01, // interrupt acknowledge
  WO: 0x02, //   write/output — active LOW (set = a read cycle)
  STACK: 0x04, // stack access
  HLTA: 0x08, // halt acknowledge
  OUT: 0x10, //  output write
  M1: 0x20, //   first machine cycle (opcode fetch)
  INP: 0x40, //  input read
  MEMR: 0x80, // memory read
} as const;

const isRst = (op: number): boolean => (op & 0xc7) === 0xc7; // 11 xxx 111

// PUSH / CALL (incl. conditional) / RST / XTHL push to the stack; plus the
// direct memory stores. These make the cycle a write (WO low).
const writesMemory = (op: number): boolean =>
  op === 0x32 || // STA
  op === 0x22 || // SHLD
  op === 0x02 || op === 0x12 || // STAX B/D
  op === 0x36 || // MVI M,d8
  (op >= 0x70 && op <= 0x77 && op !== 0x76) || // MOV M,r
  op === 0xc5 || op === 0xd5 || op === 0xe5 || op === 0xf5 || // PUSH
  op === 0xcd || op === 0xc4 || op === 0xcc || op === 0xd4 || op === 0xdc ||
  op === 0xe4 || op === 0xec || op === 0xf4 || op === 0xfc || // CALL (all)
  op === 0xe3 || // XTHL
  isRst(op);

const touchesStack = (op: number): boolean =>
  op === 0xc5 || op === 0xd5 || op === 0xe5 || op === 0xf5 || // PUSH
  op === 0xc1 || op === 0xd1 || op === 0xe1 || op === 0xf1 || // POP
  op === 0xcd || op === 0xc4 || op === 0xcc || op === 0xd4 || op === 0xdc ||
  op === 0xe4 || op === 0xec || op === 0xf4 || op === 0xfc || // CALL (all)
  op === 0xc9 || op === 0xc0 || op === 0xc8 || op === 0xd0 || op === 0xd8 ||
  op === 0xe0 || op === 0xe8 || op === 0xf0 || op === 0xf8 || // RET (all)
  op === 0xe3 || // XTHL
  isRst(op);

/** The status byte characterizing one opcode's machine cycles. */
export function statusByteForOpcode(op: number): number {
  // Every instruction begins with an M1 opcode fetch — a memory read.
  let s = STATUS.M1 | STATUS.MEMR | STATUS.WO;
  if (op === 0x76) return s | STATUS.HLTA; // HLT
  if (op === 0xdb) s |= STATUS.INP; // IN port
  if (op === 0xd3) s = (s | STATUS.OUT) & ~STATUS.WO; // OUT port (a write cycle)
  if (touchesStack(op)) s |= STATUS.STACK;
  if (writesMemory(op)) s &= ~STATUS.WO; // a write cycle drives WO low
  return s;
}

/** A 256-entry lookup so `step()` pays only one array read. */
export function buildStatusTable(): Uint8Array {
  const t = new Uint8Array(256);
  for (let op = 0; op < 256; op++) t[op] = statusByteForOpcode(op);
  return t;
}

/** The status byte during an interrupt-acknowledge machine cycle. */
export const INTA_STATUS = STATUS.INTA | STATUS.M1 | STATUS.WO;

/** The idle/reset fetch pattern (about to fetch the first opcode). */
export const FETCH_STATUS = STATUS.M1 | STATUS.MEMR | STATUS.WO;
