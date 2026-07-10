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
ICpu (Cpu8080 | CpuZ80) → IBus → Bus (SystemBus)
                                   ├─ BusRegion[] (sorted IMemory regions, 16-bit address space)
                                   ├─ IoSpace     (Map<port, IIODevice>, 8-bit I/O space)
                                   └─ IInterruptController (PIC)
```

## Pluggable CPUs

Two CPU cores share the same bus/memory/IO/interrupt stack: the Intel **8080**
(`src/cpu/Cpu8080.ts`) and a full Zilog **Z80** (`src/cpu/z80/CpuZ80.ts`). Both
implement `ICpu` (`src/interfaces/ICpu.ts`: `step/reset/run/halted/pc`) and take
the same `(bus, pic)` constructor, so `MachineRunner` (which only needs
`ISteppable`) drives either unchanged. Pick the core at construction —
`examples/boot-cpm.ts` honors `CPU=z80`. Stock Altair CP/M is 8080-compatible,
so it boots on the Z80 too.

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

## Z80 core (`src/cpu/z80/`)

Fully implements documented **and** undocumented instructions (validated against ZEXDOC and ZEXALL).

**Decoder:** `DecoderZ80` holds six tables — `main`/`mainIX`/`mainIY` (the unprefixed space viewed through HL/IX/IY), `cb`, `ed`, and `idxCb` (DDCB/FDCB bodies). The three main tables are built from the *same* view-parameterized `registerXxx(table, view: IndexView)` factories (`src/cpu/z80/instructions/*.ts`), so undocumented `IXH/IXL/IYH/IYL` forms and the `(IX+d)/(IY+d)` memory forms fall out for free.

**Handler signature:** `(cpu: Z80Core) => number`. `Z80Core` (`types.ts`) exposes `regs/flags/bus`, `iff1/iff2/im/pendingEI/halted`, and `fetchByte/fetchWord/push16/pop16`. CB/ED handlers take the same signature; DDCB/FDCB handlers are `(cpu, addr) => number` (address precomputed by the dispatcher).

**Cycle convention:** handlers return T-states from the opcode byte onward; `CpuZ80.step()` adds **4 per DD/FD prefix byte** consumed. Plain CB handlers include the CB prefix in their count; indexed CB handlers return the count minus the DD/FD prefix.

**DDCB/FDCB fetch order:** wire order is `DD CB d op` — the displacement comes *before* the final opcode, and that final byte is **not** an M1 fetch (R increments only for DD and CB). Result-copy variants write the result back into register `op & 7` unless it is 6.

**Registers/Flags:** `RegistersZ80` has the main + shadow (`a2..l2`) sets, `ix/iy`, `i`, `r` (bit 7 sticky via `incR()`), and internal `wz` (MEMPTR — drives `BIT n,(HL)` X/Y). `FlagsZ80` byte layout is `S Z Y H X PV N C`. Shared flag math lives in `flagHelpers.ts` (`add8/sub8/cp8/inc8/dec8/adc16/sbc16/…`, each setting the undocumented X/Y bits).

**Interrupts:** IFF1/IFF2, `IM 0/1/2`, and NMI (`triggerNMI()`, vectors to 0x0066, preserves IFF2). `IInterruptController` is unchanged — in IM0 the `acknowledge()` byte is executed as an opcode (stock PIC returns a single-byte RST); in IM2 it is the low half of the `(I<<8)|byte` vector pointer.

## Integration tests

- **8080:** place `cpudiag.com` at `tests/fixtures/cpudiag.com`. The test stubs CP/M BDOS at 0x0005, intercepts `C=2` (CONOUT) and `C=9` (print string), and expects output containing `CPU IS OPERATIONAL` before HLT.
- **Z80:** `npm run fixtures:z80` downloads `prelim.com`/`zexdoc.com`/`zexall.com` (public domain). `prelim.com` runs always (`tests/integration/z80-prelim.test.ts`, ~1s via the shared `runCpmProgram` harness in `z80cpm.ts`); the multi-minute `zexdoc`/`zexall` exercisers are gated behind `Z80_ZEX=1` (`z80-zex.test.ts`). All skip gracefully when the fixture is absent.
