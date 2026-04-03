# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm test              # run all tests once
npm run test:watch    # run tests in watch mode
npm run build         # tsc + esbuild browser bundle
vitest run tests/cpu/alu.test.ts   # run a single test file
```

## Architecture

The CPU holds only a reference to `IBus`. All memory, I/O, and interrupt logic lives behind that interface — the CPU is fully unit-testable with a mock bus and every peripheral is independently swappable.

```
Cpu8080 → IBus → Bus (SystemBus)
                   ├─ BusRegion[] (sorted IMemory regions, 16-bit address space)
                   ├─ IoSpace     (Map<port, IIODevice>, 8-bit I/O space)
                   └─ IInterruptController (PIC)
```

**`Cpu8080.step()` flow** (order matters):
1. Halted check — if halted and INTE+pending, take interrupt; else return idle cycles
2. `pendingEI → inte=true` — EI promotes to INTE *before* the interrupt check, so the instruction after EI is the first interruptible one
3. Interrupt check — if `inte && pic.hasPendingInterrupt()`, call `handleInterrupt()` (pushes PC, jumps to RST vector)
4. Fetch opcode; HLT/EI/DI handled inline (not via Decoder)
5. Dispatch through `Decoder` (256-entry `InstructionHandler[]`)

**`InstructionHandler` signature:** `(regs: Registers, flags: Flags, bus: IBus) => number` — returns T-states.

**Instruction files** (`src/cpu/instructions/`) each export a single `registerXxx(decoder)` function that calls `decoder.register(opcode, handler)`. All are wired in `Cpu8080.buildDecoder()`.

**Memory-mapped I/O:** `MemoryMappedIOAdapter` wraps an `IIODevice` as `IMemory`, letting a device appear simultaneously in both memory and I/O space with no CPU/bus changes.

**Browser portability:** no `process.*`, no `setImmediate`, no `Buffer`, no Node built-ins in `src/`. Use `Uint8Array`, `performance.now()`, `setTimeout(fn, 0)`. Node-only code (e.g. `fs.readFileSync`) belongs in `tests/` only.

**Flags PSW byte format:** `S Z 0 AC 0 P 1 CY` (bit 1 always 1). `Flags.toByte()` / `Flags.fromByte()` handle serialization for `PUSH PSW` / `POP PSW`.

**`InterruptController`:** bitmask of pending IRQ lines; `acknowledge()` returns `0xC7 | (lowestLine << 3)` — the RST *n* opcode byte. RST vector = `rstByte & 0x38`.

## Integration test

Place `cpudiag.com` at `tests/fixtures/cpudiag.com`. The test stubs CP/M BDOS at 0x0005, intercepts `C=2` (CONOUT) and `C=9` (print string), and expects output containing `CPU IS OPERATIONAL` before HLT.
