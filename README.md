# 8sim — Intel 8080 / Zilog Z80 CPU Simulator

A modular, extensible Intel 8080 **and** Zilog Z80 CPU simulator written in TypeScript. The CPU core is cleanly separated from memory, I/O, and bus peripherals behind well-defined interfaces, making every component independently testable and swappable — including the CPU itself, which is pluggable between the 8080 and a full Z80.

Runs in Node.js, browsers, Deno, and Bun — zero runtime dependencies.

---

## Features

- Complete Intel 8080 instruction set
- **Pluggable CPU**: full Zilog Z80 core alongside the 8080 (validated against ZEXDOC + ZEXALL)
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
│            ICpu (Cpu8080 | CpuZ80)                │
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

## Z80 CPU

`CpuZ80` (`src/cpu/z80/`) is a second, fully-implemented CPU core that runs on the
same bus, memory, I/O, and interrupt infrastructure. It covers the complete
documented **and** undocumented instruction set — CB/DD/ED/FD/DDCB/FDCB prefixes,
the `IXH/IXL/IYH/IYL` and `SLL` opcodes, the DDCB result-copy variants, and the
undocumented X/Y flags (with MEMPTR/WZ modeling). Correctness is validated against
the standard **ZEXDOC** and **ZEXALL** exercisers.

```ts
import { CpuZ80, Bus, Ram, InterruptController } from './src/index.js';

const pic = new InterruptController();
const bus = new Bus(pic);
bus.attachMemory(new Ram('ram', 0, 0x10000));
const cpu = new CpuZ80(bus, pic);   // same (bus, pic) constructor as Cpu8080
cpu.step();                          // returns T-states
```

Both cores implement the lightweight `ICpu` interface (`step/reset/run/halted/pc`)
and share the `(bus, pic)` constructor, so `MachineRunner` drives either without
changes. `examples/boot-cpm.ts` selects the core via the `CPU` env var
(`CPU=z80 npm run boot:cpm`); stock Altair CP/M is 8080-compatible and boots on
the Z80 unchanged.

**Extras beyond the 8080:** shadow registers (`EXX`, `EX AF,AF'`), `IX/IY` index
registers with displacement, block transfer/search/I-O ops (`LDIR`, `CPIR`,
`OTIR`, …), interrupt modes `IM 0/1/2` with `IFF1/IFF2`, and non-maskable
interrupts (`cpu.triggerNMI()`). The flags byte layout is `S Z Y H X PV N C`.

### Z80 validation ROMs

```bash
npm run fixtures:z80    # downloads prelim/zexdoc/zexall into tests/fixtures/
```

`prelim.com` runs as part of the normal test suite (~1s). The exhaustive
`zexdoc`/`zexall` exercisers take minutes and are gated:

```bash
Z80_ZEX=1 npx vitest run tests/integration/z80-zex.test.ts
```

---

## Clocks & CPU Speed

### `MachineRunner`

The recommended way to run a machine in real time. Drives `cpu.step()` at a configurable speed — an authentic **2 MHz by default** — pacing simulated T-states against wall time. Software written for the 8080 (delay loops, disk timing, serial pacing) behaves correctly at 2 MHz; `'max'` runs unthrottled.

```ts
import { MachineRunner } from '8sim';

const runner = new MachineRunner(cpu);                    // 2 MHz (stock 8080)
const runner = new MachineRunner(cpu, { hz: 4_000_000 }); // 4 MHz
const runner = new MachineRunner(cpu, { hz: 'max' });     // unthrottled

runner.start();
runner.setHz('max');       // change speed while running
console.log(runner.effectiveHz); // measured speed, for status displays
runner.stop();
```

Pacing details: the CPU runs in ~1 ms slices of simulated time against absolute wall-time accounting (scheduler jitter self-corrects). When ahead, the runner sleeps the difference; when behind, it catches up in bounded slices (max 20 ms) so host I/O stays responsive; a host stall longer than 250 ms (GC pause, suspended tab) is forfeited rather than replayed at full speed. Browser-portable (`performance.now` + `setTimeout`); Node callers can pass a `schedule` option using `setImmediate` for higher `'max'` throughput.

### `ImmediateClock`

Counts T-states with no wall-time throttling. Suitable for tests and maximum-speed emulation.

```ts
const clock = new ImmediateClock();
const cycles = cpu.step();
clock.addCycles(cycles);
console.log(clock.getElapsedCycles()); // bigint
```

### `SystemClock`

The pacing engine used by `MachineRunner` — a T-state counter with a target frequency and absolute drift accounting (`getAheadMs()`, `setHz()`, `resync()`). Use it directly only if you're writing your own run loop.

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

## Examples: Interactive CP/M Boot

`examples/boot-cpm.ts` boots CP/M on the emulated 8080 (88-DSK boot PROM + 8251 console + MITS 88-DCDD floppy controller) against a live fdcplus-web server, bridging the console to your terminal for a real interactive session.

The same session runs on the **Z80** core two ways: set `CPU=z80 npm run boot:cpm`, or use the dedicated `examples/boot-cpm-z80.ts` via `npm run boot:cpm:z80`. Stock Altair CP/M is 8080-compatible, so it boots on the Z80 unchanged.

The server location and API token are **not** hardcoded — they are read from environment variables, loaded from a local `.env` file:

| Variable | Description | Default |
|---|---|---|
| `FDCPLUS_URL` | Base URL of the fdcplus-web server | `http://localhost:3000` |
| `FDCPLUS_TOKEN` | API token for the fdcplus-web server | *(required)* |
| `FDCPLUS_CLIENT_ID` | Stable client id for persistent disk writes | *(unset — writes are ephemeral)* |
| `CPU_HZ` | CPU speed: `2mhz`, `4mhz`, a raw Hz number, or `max` | `2mhz` |

Note on disk writes: fdcplus-web sessions are copy-on-write — writes go to a per-client "splinter", not the master disk image. Without `FDCPLUS_CLIENT_ID`, the splinter (and any files you saved) is discarded when the emulator disconnects. With a stable id, your changes persist across sessions; merge them into the master image via the server's `POST /api/drives/:id/transient/commit` endpoint.

Setup:

1. Copy the template: `cp .env.example .env`
2. Edit `.env` and set `FDCPLUS_TOKEN` (and `FDCPLUS_URL` if the server isn't on localhost)
3. Start the fdcplus-web server with a bootable disk mounted on drive 0
4. Run `npm run boot:cpm`

The `.env` file is gitignored so your token is never committed. The npm script loads it via Node's built-in `--env-file-if-exists` flag (requires Node ≥ 22), so no dotenv dependency is needed. Type at the `A>` prompt; press `Ctrl-]` to quit. Disk writes are flushed back to the mounted image on the server.

The live boot integration test (`tests/integration/bootdisk.live.test.ts`) uses the same variables; the vitest config loads `.env` automatically. The test skips itself when `FDCPLUS_TOKEN` is unset or the server is unreachable.

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
│   ├── Cpu8080.ts          — Intel 8080 CPU: step(), run(), interrupt handling
│   ├── Registers.ts        — A B C D E H L SP PC, pair accessors
│   ├── Flags.ts            — S Z AC P CY, PSW byte serialize/deserialize
│   ├── Decoder.ts          — 256-entry InstructionHandler dispatch table
│   ├── instructions/       — one file per 8080 instruction group
│   └── z80/                — Zilog Z80 core
│       ├── CpuZ80.ts       — step loop, DD/FD prefixes, IM 0/1/2 + NMI
│       ├── RegistersZ80.ts — main + shadow + IX/IY/I/R/WZ
│       ├── FlagsZ80.ts     — S Z Y H X PV N C
│       ├── DecoderZ80.ts   — main/IX/IY + CB/ED/DDCB tables
│       ├── flagHelpers.ts  — shared flag math (X/Y aware)
│       └── instructions/   — one file per Z80 instruction group
├── bus/                    — Bus, BusRegion
├── memory/                 — Ram, Rom, MemoryMappedIOAdapter
├── io/                     — IoSpace
├── interrupt/              — InterruptController
├── clock/                  — ImmediateClock, SystemClock
├── interfaces/             — ICpu IBus IMemory IIODevice IInterruptController IClock IModule
└── util/bits.ts            — u8 u16 signBit zeroFlag parityFlag auxCarryAdd toWord hi lo
tests/
├── cpu/                    — per-instruction-group unit tests + interrupt tests
│   └── z80/                — Z80 registers, flags, CB/indexed/DDCB, interrupts
├── bus/                    — bus routing, ROM protection, MMIO
├── memory/                 — RAM, ROM, MemoryMappedIOAdapter
└── integration/            — cpudiag.com + Z80 prelim/zexdoc/zexall end-to-end tests
```

---

## License

Apache License 2.0 — see [LICENSE](LICENSE) for details.
