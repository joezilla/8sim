# 8sim — Intel 8080 CPU Simulator

A modular, extensible Intel 8080 CPU simulator written in TypeScript. The CPU core is cleanly separated from memory, I/O, and bus peripherals behind well-defined interfaces, making every component independently testable and swappable.

Runs in Node.js, browsers, Deno, and Bun — zero runtime dependencies.

---

## Features

- Complete Intel 8080 instruction set
- Pluggable bus architecture (S-100 bus style)
- Memory-mapped I/O support
- Interrupt controller with RST vector dispatch
- ROM write protection
- Accurate flag behavior (S, Z, AC, P, CY)
- EI/DI with correct one-instruction delay for EI
- HLT with interrupt wake
- Real-time and immediate-mode clocks
- Browser-safe: no Node.js globals in core library

---

## Installation

```bash
npm install
npm test
npm run build
```

---

## Quick Start

```ts
import { Cpu8080, Bus, Ram, Rom, InterruptController } from './src/index.js';

// 1. Create the interrupt controller and bus
const pic = new InterruptController();
const bus = new Bus(pic);

// 2. Attach memory
const rom = new Rom('rom', 0x0000, new Uint8Array([/* your program */]));
const ram = new Ram('ram', 0x2000, 0x4000);
bus.attachMemory(rom);
bus.attachMemory(ram);

// 3. Create and run the CPU
const cpu = new Cpu8080(bus, pic);
cpu.registers.pc = 0x0000;
cpu.registers.sp = 0x5fff;

// Step one instruction at a time
const cycles = cpu.step(); // returns T-states consumed

// Or run until HLT
cpu.run();
```

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                  Cpu8080                          │
│  Registers, Flags, Decoder, step() / run()        │
│  polls: IInterruptController                      │
│  accesses: IBus                                   │
└────────────────────┬─────────────────────────────┘
                     │ IBus
┌────────────────────▼─────────────────────────────┐
│                  Bus (SystemBus)                  │
│  memoryMap: BusRegion[]  (sorted, 16-bit addr)    │
│  ioSpace:   IoSpace      (8-bit port space)       │
│  pic:       IInterruptController                  │
└───────┬──────────────┬──────────────┬────────────┘
        │              │              │
   IMemory         IIODevice   IInterruptController
  (RAM/ROM/       (port or      (PIC / IRQ lines)
  MMIO adapter)   MMIO device)
```

The CPU holds only a reference to `IBus`. All memory, I/O, and interrupt logic is behind that interface. This lets you:

- Unit-test the CPU with a mock bus
- Swap any peripheral without touching the CPU
- Run the same code in Node or a browser

### Memory Space

`Bus` holds a sorted list of `BusRegion` entries. On each `read`/`write`, it finds the region containing the address and forwards the call as an offset into that region. Unmapped reads return `0xFF`; unmapped writes are silently ignored. ROM regions reject writes without error.

### I/O Space

`IoSpace` maps 8-bit port numbers to `IIODevice` instances. Unregistered ports return `0xFF` on read and ignore writes.

### Memory-Mapped I/O

`MemoryMappedIOAdapter` wraps any `IIODevice` as an `IMemory` region. Attach it to the bus at any base address and the device becomes accessible from both the memory and I/O address spaces simultaneously — no CPU or bus changes required.

```ts
const uart = new MyUart();
bus.attachIODevice(uart);                                    // I/O port access
bus.attachMemory(new MemoryMappedIOAdapter(0xe000, 8, uart)); // memory access
```

---

## CPU

### Registers

| Register | Width | Notes |
|----------|-------|-------|
| A        | 8-bit | Accumulator |
| B, C     | 8-bit | BC pair |
| D, E     | 8-bit | DE pair |
| H, L     | 8-bit | HL pair; M pseudo-register = `(HL)` |
| SP       | 16-bit | Stack pointer |
| PC       | 16-bit | Program counter |

`Registers` exposes `bc`, `de`, `hl` as read/write pair accessors.

### Flags

Stored as an 8080 PSW byte: `S Z 0 AC 0 P 1 CY` (bit 1 is always 1).

| Flag | Bit | Meaning |
|------|-----|---------|
| S    | 7   | Sign (bit 7 of result) |
| Z    | 6   | Zero |
| AC   | 4   | Auxiliary carry (half-carry, used by DAA) |
| P    | 2   | Parity (even popcount) |
| CY   | 0   | Carry / borrow |

### `step()` Execution Model

```
1. Halted?  → if INTE + pending interrupt: wake and handle; else return idle cycles
2. pendingEI → inte = true  (EI's one-instruction delay commits here)
3. INTE + pending? → handleInterrupt (pushes PC, jumps to RST vector)
4. Fetch opcode; HLT / EI / DI handled inline
5. Dispatch through 256-entry Decoder table → returns T-states
```

### Interrupts

```ts
// Assert an IRQ line (0–7)
pic.assertIRQ(1);

// Enable interrupts in the CPU
cpu.inte = true;

// The CPU will take the interrupt at the start of the next step()
// after any pending EI delay resolves.
```

`InterruptController.acknowledge()` returns `0xC7 | (line << 3)` — the RST *n* opcode byte. The CPU jumps to `rstByte & 0x38` (vector × 8):

| IRQ line | RST opcode | Vector |
|----------|-----------|--------|
| 0 | RST 0 | 0x0000 |
| 1 | RST 1 | 0x0008 |
| 2 | RST 2 | 0x0010 |
| … | … | … |
| 7 | RST 7 | 0x0038 |

**EI/DI behaviour:**
- `EI` sets `pendingEI=true`. Interrupts become enabled at the *start* of the next `step()` call (before the next instruction is fetched), matching real 8080 behaviour where one instruction executes after EI before interrupts are accepted.
- `DI` clears `inte` and `pendingEI` immediately.

---

## Clocks

### `ImmediateClock`

Counts T-states with no wall-time throttling. Suitable for tests and maximum-speed emulation.

```ts
const clock = new ImmediateClock();
const cycles = cpu.step();
clock.addCycles(cycles);
console.log(clock.getElapsedCycles()); // bigint
```

### `SystemClock`

Uses `performance.now()` for timing and `setTimeout(fn, 0)` for yielding. Works in Node 16+, all modern browsers, Deno, and Bun.

```ts
const clock = new SystemClock(2_000_000); // 2 MHz

async function runLoop() {
  while (!cpu.halted) {
    for (let i = 0; i < 1000; i++) {
      clock.addCycles(cpu.step());
    }
    if (clock.getAheadMs() > 2) {
      await clock.yield(); // yield to event loop to avoid blocking
    }
  }
}
```

---

## Implementing Peripherals

### Custom I/O Device

```ts
import type { IIODevice } from './src/interfaces/IIODevice.js';

class Timer implements IIODevice {
  readonly id = 'timer';
  readonly basePorts = [0x40, 0x41, 0x42, 0x43]; // 8253-style ports

  ioRead(port: number): number {
    // return timer counter byte for this port
    return 0;
  }

  ioWrite(port: number, value: number): void {
    // configure timer
  }

  reset(): void { /* ... */ }
}

bus.attachIODevice(new Timer());
```

### Custom Memory

```ts
import type { IMemory } from './src/interfaces/IMemory.js';

class BankedRam implements IMemory {
  readonly id = 'banked-ram';
  readonly baseAddress = 0x4000;
  readonly size = 0x4000;
  readonly readOnly = false;
  private banks: Uint8Array[] = [new Uint8Array(0x4000), new Uint8Array(0x4000)];
  private activeBank = 0;

  read(offset: number): number { return this.banks[this.activeBank]![offset] ?? 0xff; }
  write(offset: number, value: number): void { this.banks[this.activeBank]![offset] = value & 0xff; }
  reset(): void { this.banks.forEach(b => b.fill(0)); this.activeBank = 0; }

  selectBank(n: number): void { this.activeBank = n; }
}
```

---

## Integration Testing: cpudiag.com

The repository includes a CP/M CPU diagnostic integration test. To run it:

1. Obtain `cpudiag.com` (part of the public-domain `cpm2.asm` diagnostics suite)
2. Place it at `tests/fixtures/cpudiag.com`
3. Run `npm test`

The test loads the binary at `0x0100`, stubs the CP/M BDOS entry point at `0x0005` to capture console output, and expects the output to contain `CPU IS OPERATIONAL` before the CPU halts.

If the fixture is absent the test is silently skipped.

---

## Browser Usage

Build a single-file ESM bundle:

```bash
npm run build
# produces dist/8sim.browser.js
```

```html
<script type="module">
  import { Cpu8080, Bus, Ram, InterruptController } from './dist/8sim.browser.js';

  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0, 0x10000);
  bus.attachMemory(ram);

  const response = await fetch('myprog.bin');
  const data = new Uint8Array(await response.arrayBuffer());
  ram.load(data, 0x0100);

  const cpu = new Cpu8080(bus, pic);
  cpu.registers.pc = 0x0100;
  cpu.registers.sp = 0x0100;
  cpu.run(1_000_000);
</script>
```

---

## Project Structure

```
src/
├── cpu/
│   ├── Cpu8080.ts          — main CPU: step(), run(), interrupt handling
│   ├── Registers.ts        — A B C D E H L SP PC, pair accessors
│   ├── Flags.ts            — S Z AC P CY, PSW byte serialize/deserialize
│   ├── Decoder.ts          — 256-entry InstructionHandler dispatch table
│   └── instructions/       — one file per instruction group
├── bus/                    — Bus, BusRegion
├── memory/                 — Ram, Rom, MemoryMappedIOAdapter
├── io/                     — IoSpace
├── interrupt/              — InterruptController
├── clock/                  — ImmediateClock, SystemClock
├── interfaces/             — IBus IMemory IIODevice IInterruptController IClock IModule
└── util/bits.ts            — u8 u16 signBit zeroFlag parityFlag auxCarryAdd toWord hi lo
tests/
├── cpu/                    — per-instruction-group unit tests + interrupt tests
├── bus/                    — bus routing, ROM protection, MMIO
├── memory/                 — RAM, ROM, MemoryMappedIOAdapter
└── integration/            — cpudiag.com end-to-end test
```

---

## License

MIT
