# SKILL: The IMSAI MDC-DIO Floppy Disk Controller (DIO + PDS) — Behavior & Programming Model

## Overview

The **IMSAI MDC-DIO** is the floppy disk controller for the IMSAI 8080 / PCS-80 / VDP-80
family. It is an S-100 (Intel/IMSAI backplane) controller built from **two boards**:

- **DIO** (Floppy Disk Interface) — carries the control logic, an on-board **2 KB ROM/EPROM**
  of firmware, **256 bytes of RAM**, two **8255 PPI** chips for drive control lines, and
  serializer/deserializer + CRC hardware. It plugs into the S-100 bus.
- **PDS** (Programmable Data Separator) — a phase-locked-oscillator data separator that
  recovers clock/data from the raw drive signal. It connects to the DIO by a 20-pin cable and
  is not visible to software; it is programmed (density select) through the DIO's 8255 lines.

**The single most important fact about this controller — and what makes it completely
different from the MITS 88-DCDD — is that software does not touch registers to move bytes.
The DIO is a *firmware-driven, memory-mapped* controller.** The board appears in the
**memory** address space as a 4 KB window at **E000–EFFF**. Inside that window live the
firmware ROM, the scratch RAM, and memory-mapped I/O registers. The host program drives the
disk by **making 8080 `CALL` instructions to fixed firmware entry points** with a command
byte in the **A register**, exactly as if the floppy were a subroutine. The firmware does all
head positioning, address-mark synchronization, byte transfer, CRC, retry, and error
recovery internally. The program never spins on a data-ready bit and never issues an `IN`/`OUT`
per byte.

Because of this, there are **two very different levels** at which the MDC-DIO can be
understood and virtualized:

1. **The firmware-API level** — the subroutine-call contract (entry points, the *Byte
   Command*, the *Command String* in RAM, the returned status word). This is what operating
   systems (IMDOS, CP/M BIOS) actually use. **For 8sim this is the level to emulate.**
2. **The bare-hardware level** — the 8255 control-register bit assignments, the WAIT-state
   byte-synchronization addresses, the PDS density lines, CRC hardware, and bit/byte timing.
   The real 2716 firmware ROM drives *this* level. You only need it if you intend to run the
   genuine firmware ROM image bit-accurately.

Both levels are documented below. The virtualization guidance at the end explains why the
firmware-API level is the practical target and how to wire it into the 8sim `IBus` /
`IMemory` model.

---

## Two I/O ports vs. the memory window (don't confuse them)

The DIO occupies **two address spaces at once**:

| Space | Range | Purpose |
|-------|-------|---------|
| **Memory** | `E000`–`EFFF` (4 KB) | ROM firmware, scratch RAM, and memory-mapped device registers. **All real work happens here.** |
| **I/O** | ports `XE` and `XF` | *Only* enable/disable the board's response to the `E000–EFFF` memory window. |

The two I/O ports are **switch-selected** to `XE`/`XF` where `X` is any hex digit 0–F (so a
board set to `X=D` uses ports `DE`/`DF`; a second board could use `EE`/`EF`). Their sole
function is coexistence with RAM that overlaps `E000–EFFF`:

- **`OUT XE`** — *disable* the DIO (let RAM at `E000–EFFF` respond instead).
- **`OUT XF`** — *enable* the DIO (the board responds at `E000–EFFF`).
- The **data value written is ignored** (any value). Only the port address matters.

On **RESET / power-on-clear** the board comes up **enabled** by default (jumper trace L→M).
A system with no overlapping RAM at `E000–EFFF` never needs to touch these ports at all.

> **Key consequence:** you cannot DMA/transfer data *into* `E000–EFFF` with the floppy —
> those are the board's own addresses. `Byte 7` of a command string (memory-address high) may
> not be `E0`.

### Address / drive configuration switches (U3 DIP switch)

| Switch | Function |
|--------|----------|
| 1–4 | I/O port page select (the `X` nibble). DIO 1 conventionally = `D`, DIO 2 = `E`. A `1` bit = switch OFF. |
| 5 | Standard drive type: OFF = Shugart/GSI, ON = PERSCI. |
| 6 | Recording density: ON = single density (FM), OFF = double density (MFM). |
| 7 | CPU/clock: ON = 2 MHz 8080 (MPU-A), OFF = 3 MHz 8085 (MPU-B). Affects firmware timing loops. |
| 8 | Unused. |

Multiple DIO boards can coexist by giving each a different `X`; jumpers ensure exactly one is
enabled at reset. An **IMM** (extended-address) jumpering option places the board in the top
64 KB page of the megabyte space, still at `E000–EFFF` within that page.

---

## Memory Map of the E000–EFFF Window

This is the authoritative layout of the 4 KB window (from the DIO Board User Guide).

| Range | R/W | Contents |
|-------|-----|----------|
| **E000–E7FF** | R | **2 KB firmware ROM/EPROM** (single 2316/2716). Holds all drivers + the entry-point jump vectors. |
| **E800–E8FF** | R/W | **256 bytes on-board RAM** (two 8111 chips). |
| — `E800–E87F` | R/W | First 128 bytes: firmware scratch + parameters (see below). |
| — `E880–E8FF` | R/W | Last 128 bytes: **free for user program**, not used by firmware. |
| **E900** | W | **OC1** — Output Control 1 (8255 #1 Port A). |
| **E901** | R | **IS1** — Input Sense 1 (8255 #1 Port B). |
| **E902** | W | **OC2** — Output Control 2 (8255 #1 Port C). |
| **E903** | W | 8255 #1 **control word** — load `82h` after every RESET. |
| E904–E9FF | — | Undefined. |
| **EA00** | R | **IS2** — Input Sense 2 (8255 #2 Port A). |
| **EA01** | W | **OC3** — Output Control 3 (8255 #2 Port B). |
| **EA02** | W | **OC4** — Output Control 4 (8255 #2 Port C). |
| **EA03** | W | 8255 #2 **control word** — load `90h` after every RESET. |
| EA04–EAFF | — | Undefined. |
| **EB00** | R | **Address-Mark synchronous read** — reading **stalls the CPU in a WAIT state** until the clock-pattern comparator matches an Address Mark; then returns the data byte at that AM. |
| EB01–ECFF | — | Undefined. |
| **ED00** | R | **Byte-complete synchronous read** — reading **WAITs** until the next serial byte is assembled, then returns it. |
| ED01–EDFF | — | Undefined. |
| **EE00** | W | **Byte-complete synchronous write** — writing **WAITs** until the controller can accept the next output byte, then loads it. |
| EE01–EEFF | — | Undefined. |
| **EF00** | W | **Head-load one-shot trigger** — any write retriggers the head-load timer (data ignored). |
| EF01–EFFF | — | Undefined. |

**The WAIT-state addresses (`EB00`, `ED00`, `EE00`) are the crux of the hardware-level byte
transfer.** Instead of polling a status bit, the firmware simply does a `MOV A,M` /
`MOV M,A` against these addresses and the DIO hardware freezes the CPU (asserts the S-100
`PRDY`/wait line) until the byte boundary arrives — a **hardware handshake via bus WAIT
states**, not a software poll. A safety one-shot (74LS123) caps the wait so a stuck drive
cannot hang the bus forever.

### Firmware entry-point jump vectors (start of ROM)

The first bytes of ROM are `C3` (`JMP`) instructions. On the front panel, EXAMINE at these
addresses shows **`C3`** in the data lights — the documented sanity check before booting.

| Address | Vector |
|---------|--------|
| **E000** | `JMP` → bootstrap using **standard** drive 0 |
| **E003** | `JMP` → bootstrap using **mini** drive 0 |
| **E006** | `JMP` → **command entry, standard drives** |
| **E009** | `JMP` → **command entry, mini drives** |
| **E00C** | `JMP` → **initialization** (drive-type independent) |

These five 3-byte slots are the entire public API surface. Everything a program does with the
disk is a `CALL` to `E006`, `E009`, or `E00C` (or an EXAMINE+RUN at `E000`/`E003` to boot).

### On-board RAM parameter layout (E800…)

| Address | Meaning |
|---------|---------|
| `E800` | Drive-type/format byte for **standard** drive 0 |
| `E801` | …standard drive 1 |
| `E802` | …standard drive 2 |
| `E803` | …standard drive 3 |
| `E804` | Drive-type byte for **mini** drive 0 |
| `E805` | …mini drive 1 |
| `E806` | …mini drive 2 |
| `E80F` | Shadow of OC1 register value |
| `E810` | Shadow of OC2 register value |
| `E811` | Shadow of OC3 register value |
| `E812` | Shadow of OC4 register value |
| (elsewhere in E800–E87F) | 16-entry pointer table (2 bytes each), head-position-per-drive memory, retry counters, scratch |

The 8255 output ports are **write-only**, so the firmware keeps **shadow copies** (`E80F–E812`)
of OC1–OC4 in RAM. To change one control bit it reads the shadow, modifies the bit, writes
both the shadow and the port. **A virtual 8255 model must allow read-back of last-written
values, or the firmware's read-modify-write of control lines breaks.**

**Drive-type byte values** (written by INIT/bootstrap from the config switches; the program
may overwrite them to change format on the fly):

Standard drives (`E800`–`E803`):

| Value | Meaning |
|-------|---------|
| `2` | SA800 or GSI-110, **single density** (FM, IBM 3740) |
| `3` | SA800 or GSI-110, **double density** (MFM) |
| `0` | PERSCI 270, single density, **side 0** (only valid at E800/E802) |
| `4` | PERSCI 270, single density, **side 1** (only valid at E801/E803) |
| `1` | PERSCI 270, single density, side 0 (E800/E802) |
| `5` | PERSCI 270, single density, side 1 (E801/E803) |

Mini drives (`E804`–`E806`): **must be `6`** = 125 kHz single-density FM mini.

Because the firmware re-reads these on every read/write, a single physical drive can be told
to read an IBM-3740 SD diskette, then switched (by poking `E800`) to MFM DD — the "same drive,
different format under program control" feature the manual advertises.

---

## The Firmware Programming Model (the level software uses)

### The subroutine contract

> Think of the floppy as a subroutine. Put a command byte in `A`, `CALL` an entry point, and
> on return `A` holds the **status word**. Non-zero = operation finished; the same status is
> also written into the Command String's status byte.

There are **two kinds of command** the program issues:

1. **Byte Command** — a single byte in `A`, `CALL`ed directly. Does immediate small actions
   (set a pointer, restore a drive, toggle write-protect) *and* is the trigger that launches a
   Command String.
2. **Command String** — a multi-byte descriptor built in main RAM that describes a full
   read/write/format/verify operation. It is executed indirectly, by issuing **Byte Command 0**
   with a pointer number.

`E00C` (**INIT**) must be called once after power-up/RESET before any other command. It reads
the config switches into the drive-type RAM bytes, loads the 16 pointer defaults, and writes
the 8255 control words (`82h`→`E903`, `90h`→`EA03`). Booting via `E000`/`E003`, or booting any
MPU-B firmware, performs INIT automatically.

### Byte Command format

```
 bit  7  6  5  4 | 3  2  1  0
     [ CMD # (0-F) ][ POINTER # or DRIVE-SELECT mask ]
```

Upper nibble = command number; lower nibble = a **pointer number (0–15)** for commands 0/1,
or a **drive-select bitmask** (bit0=drive0 … bit3=drive3) for commands 2/3/4.

| Byte Cmd | Lower nibble | Action |
|----------|--------------|--------|
| **0X** | pointer X | **Execute the Command String** pointed to by pointer X. This is the workhorse. |
| **1X** | pointer X | **Set pointer X's address.** Pass three successive bytes to the entry point: first `A=1X`, then `A=LOW addr byte`, then `A=HIGH addr byte`. (Each byte is a separate `CALL`.) |
| **2X** | drive mask | **Restore** (seek to track 0) each selected drive on its next reference. |
| **3X** | drive mask | **Set software write-protect** on selected drives. |
| **4X** | drive mask | **Software write-enable** (clear write-protect) on selected drives. |
| **5X–FX** | — | No operation. |

> After power-up all drives come up **write-enabled**; software write-protect (cmd 3) is
> opt-in. A command with an empty drive mask (`X=0`) for cmds 2/3/4 is a no-op.

**Pointer default table** (loaded by INIT). Pointer N → address `N × 0x1000`, except pointer 0:

| Ptr | Addr | Ptr | Addr | Ptr | Addr | Ptr | Addr |
|-----|------|-----|------|-----|------|-----|------|
| 0 | `0080` | 4 | `4000` | 8 | `8000` | C | `C000` |
| 1 | `1000` | 5 | `5000` | 9 | `9000` | D | `D000` |
| 2 | `2000` | 6 | `6000` | A | `A000` | E | `E000` |
| 3 | `3000` | 7 | `7000` | B | `B000` | F | `F000` |

(Pointer 0 defaults to `0080` because the bootstrap loads sector 1 to `0000–007F` and code
typically continues just above it.)

### Command String format (in main RAM)

A Command String is 4–7 consecutive bytes. `CALL E006`/`E009` with `A=0X` executes the string
whose address is in pointer `X`.

| Byte | Name | Meaning |
|------|------|---------|
| **1** | Command byte | Upper nibble = **Command String command #** (see table); lower nibble = **drive-select mask** (exactly one drive bit should be set). |
| **2** | Status | Firmware writes the result here (and returns it in `A`). Set it to 0 before issuing (optional). |
| **3** | Track (high) | **Must be 0** (reserved for expansion). |
| **4** | Track (low) | Target track: 0–76 standard, 0–34 mini. |
| **5** | Sector | Target sector (see ranges). Required for read/write/verify/deleted-mark. |
| **6** | Buffer addr (low) | LSB of the main-memory data buffer. Required for read/write. |
| **7** | Buffer addr (high) | MSB of buffer. **May not be `E0`** (would collide with the DIO window). |

**Command String command numbers** (Byte 1, upper nibble):

| Cmd | Operation | Uses bytes 5–7? |
|-----|-----------|-----------------|
| 0 | **Not used** | — |
| **1** | **Write Sector** — write 128 bytes from buffer (6/7) to track/sector. | 5, 6, 7 |
| **2** | **Read Sector** — read 128 bytes from track/sector into buffer (6/7). | 5, 6, 7 |
| **3** | **Format Track** — write a fresh format on the track in byte 4. **Destroys the whole track.** | uses only 1–4 |
| **4** | **Verify Sector** — read + check CRC of the sector; **no data transfer** to memory. | 5 (no 6/7) |
| **5** | **Write Deleted-Data Mark** — write a deleted-data address mark in the sector. | 5 |

### Sector / track ranges by geometry

| Drive / format | Tracks | Sectors | Bytes/sector | Encoding |
|----------------|--------|---------|--------------|----------|
| **Mini (SA400)** | 0–34 (35) | **1–18** | 128 | FM 125 kHz |
| **Standard SD (SA800/GSI, IBM 3740)** | 0–76 (77) | **1–26** | 128 | FM 250 kHz |
| **Standard DD (MFM)** | 0–76 (77) | **1–58** | 128 | MFM 500 kHz |
| **PERSCI 270** | dual, SD/DD | as above | 128 | FM/MFM |

> Note sectors are **1-based** in the Command String (1–18 / 1–26 / 1–58), while the boot ROM
> and CP/M layers may present 0-based or physically-skewed numbering. Keep the firmware-visible
> numbering 1-based when emulating the command string.

### Status word / error codes (returned in A and Byte 2)

```
 bit 7  6  5  4 | 3  2  1  0
     E  Cs Ac Hw [ specific code nibble ]
```

- **Success:** status is non-zero with **bit 7 = 0**; **bit 0 = 1** (`01`) marks a clean
  completion.
- **Error:** **bit 7 = 1**. The class bit (6/5/4) plus the low nibble give the specific code:

| Code | Class (bit) | Meaning |
|------|-------------|---------|
| `C2` | Command-string (6) | No drive selected |
| `C3` | " | More than one drive selected |
| `C4` | " | Illegal command number in string |
| `C5` | " | Illegal track address |
| `C6` | " | Illegal sector address |
| `C7` | " | Illegal data-buffer location (e.g. high byte = `E0`) |
| `A1` | Recoverable (5) | Selected drive not ready |
| `A2` | " | Drive is **hardware** write-protected, write attempted |
| `A3` | " | Drive is **software** write-protected, write attempted |
| `91` | Hardware (4) | Drive inoperable — could not reach track 0, or not ready mid-op |
| `92` | " | Track-address mismatch (firmware re-seeks 3× before reporting) |
| `93` | " | Sector not found / data-sync error (3× re-seek before reporting) |
| `94` | " | CRC error in the **ID** field (retried 20× before reporting) |
| `96` | " | CRC error in the **data** field (retried 20×; **data is still transferred**) |
| `97` | " | Deleted-data mark encountered (data transferred, no CRC error, no retry) |

**The retry/recovery counts matter for a faithful emulation of *behavior*:** a real read of a
bad sector takes visibly longer (20 retries × ~1 revolution) and *still delivers data* on `96`.
A `97` deleted-data mark is not an error to abort on — data is valid.

### Canonical read flow (what an OS BIOS does)

```asm
; ---- one-time, after RESET ----
        CALL  0E00CH        ; INIT: load switches, pointers, program 8255s

; ---- set pointer 0 to our command string at CMDSTR ----
        MVI   A,10H         ; Byte Command 1, pointer 0
        CALL  0E006H        ; standard-drive entry
        MVI   A,CMDSTR AND 0FFH
        CALL  0E006H        ; low address byte
        MVI   A,CMDSTR SHR 8
        CALL  0E006H        ; high address byte

; ---- build the command string in RAM ----
CMDSTR: DB    21H           ; Byte1: cmd 2 (READ) | drive 1 (bit0)
        DB    00H           ; Byte2: status (firmware fills in)
        DB    00H           ; Byte3: track high = 0
        DB    trk           ; Byte4: track
        DB    sec           ; Byte5: sector (1-based)
        DW    BUFFER        ; Byte6/7: destination buffer (high != E0)

; ---- execute it ----
        MVI   A,00H         ; Byte Command 0, pointer 0 -> run the string
        CALL  0E006H
        ANI   80H           ; A = returned status; bit7 set => error
        JNZ   DISK_ERROR
        ; success: 128 bytes are now in BUFFER
```

Writing is identical with Byte1 = `1X`; formatting uses `3X` and only bytes 1–4; verify uses
`4X` with byte 5 and no buffer.

---

## System Bootstrap

The ROM bootstrap **reads track 0, sector 1 from drive 0 into main RAM `0000–007F`, then
`JMP 0000`**. It auto-retries on hardware error until it succeeds or is stopped.

Front-panel procedure (IMSAI 8080):

1. Remove diskettes; power up computer, then the drive.
2. Insert system diskette in drive 0.
3. Set ADDRESS switches to **`E000`** (standard drive) or **`E003`** (mini drive); press
   **EXAMINE** — the data lights should read **`C3`** (the `JMP` opcode).
4. Press **RUN**. The OS (e.g. IMDOS) loads and runs.

So the boot sector is a single **128-byte** payload at `0x0000` that then loads the rest of the
OS via further firmware `CALL`s. Any 8sim boot-CP/M path must reproduce: *sector-1/track-0 →
0x0000, jump to 0x0000*.

---

## Bare-Hardware Level (only needed to run the real ROM)

If you emulate the genuine 2716 firmware image bit-for-bit, you must model the two 8255s, the
WAIT-state sync addresses, the density lines, and the CRC/serializer. Bit assignments follow.

### 8255 #1 — control at E903 (mode word `82h`)

**OC1 (E900, write, Port A):**
| Bit | Function |
|-----|----------|
| 0 | Enable CRC calculation |
| 1 | Clock-recognition pattern bit 0 (AM detect) |
| 2 | Clock-recognition pattern bit 2 |
| 3 | Clock-recognition pattern bit 3 |
| 4 | **Write gate** — enable write on selected drive |
| 5 | Write-precomp/format ROM group LSB |
| 6 | …group MSB (`00`=FM, `10`=MFM, `11`=Address-Mark write, `01`=unused) |
| 7 | Shift CRC bytes out onto the data line (record CRC) |

**IS1 (E901, read, Port B):**
| Bit | Function |
|-----|----------|
| 0 | Mini write-protect (0 = protected) |
| 1 | Value of config switch 6 (density) |
| 2 | Value of config switch 5 (drive type) |
| 3 | PERSCI seek-complete (0 = complete) |
| 4 | Value of config switch 7 (CPU type) |
| 5 | PERSCI side-1 ready (0 = ready) |
| 6 | Mini track-00 (0 = over track 0) |
| 7 | Mini index pulse (0 = index present) |

**OC2 (E902, write, Port C):**
| Bit | Function |
|-----|----------|
| 0 | Mini **Step** line |
| 1 | Mini Drive-Select 1 |
| 2 | Mini Drive-Select 2 |
| 3 | Mini Drive-Select 3 |
| 4 | Mini **Motor On** |
| 5 | Mini **Direction** (0 = step out toward lower track) |
| 6 | Clock-recognition pattern bit 1 |
| 7 | Preset CRC register to all ones |

### 8255 #2 — control at EA03 (mode word `90h`)

**IS2 (EA00, read, Port A):**
| Bit | Function |
|-----|----------|
| 0 | Head-load-active one-shot state (1 = heads still loaded) |
| 1 | CRC result (0 = OK) |
| 2 | PERSCI side-1 write-protect (0 = protected) |
| 3 | Standard-drive index pulse (0 = present) |
| 4 | Shugart disk-change line |
| 5 | Standard-drive ready (0 = ready) |
| 6 | Standard-drive track-00 (0 = over track 0) |
| 7 | Standard-drive write-protect (0 = protected) |

**OC3 (EA01, write, Port B):**
| Bit | Function |
|-----|----------|
| 0 | GSI low-current line |
| 1 | PERSCI restore line |
| 2 | Standard Drive-Select 3 |
| 3 | Standard Drive-Select 4 |
| 4 | Standard **Direction** (0 = step out to lower track) |
| 5 | Standard Drive-Select 2 |
| 6 | Standard **Step** line |
| 7 | Standard Drive-Select 1 |

**OC4 (EA02, write, Port C):**
| Bit | Function |
|-----|----------|
| 0 | PERSCI head-load side 1 |
| 1 | Unused |
| 2 | Density select MSB |
| 3 | Density select LSB (`00`=125 kHz FM, `10`=250 kHz FM, `11`=500 kHz MFM) |
| 4 | Standard-drive head load |
| 5 | PERSCI remote-eject side 0 |
| 6 | PERSCI side select (1 = side 1) |
| 7 | PERSCI motor on |

### Byte / address-mark synchronization

- Reading **`ED00`** stalls (WAIT) until a full serial byte has been deserialized, then returns
  it. Writing **`EE00`** stalls until the shifter can take the next byte. This is a pure
  bus-WAIT handshake; there is no "data ready" status bit to poll.
- Reading **`EB00`** stalls until the clock-pattern comparator (loaded via OC1/OC2 clock-
  recognition bits) matches an **Address Mark** with the expected *missing clocks*; then returns
  the AM's data byte. This is how the firmware finds ID and Data marks.
- Writing **`EF00`** retriggers the **head-load one-shot** (data ignored) to keep the head loaded
  during a multi-sector operation.

### Address Marks & missing-clock patterns

Soft-sectored recording identifies fields by AM bytes written with **missing clock bits**
(illegal under normal FM/MFM encoding):

| Mark | FM byte | Missing clocks (FM) | MFM byte | Missing clock (MFM) |
|------|---------|---------------------|----------|---------------------|
| Index AM | `FC` | cells 2,4 | `0C` | cell 3 |
| ID AM | `FE` | cells 2,3,4 | `0E` | cell 3 |
| Data AM | `FB` | cells 2,3,4 | `0B` | cell 3 |
| Deleted-data AM | `F8` | cells 2,3,4 | `08` | cell 3 |

### Track layout (IBM-3740-compatible SD example, 26 sectors)

Per sector: `SYNC(6·00) · ID-AM(FE) · [track,0,sector,0] · CRC(2) · GAP2 · SYNC(6·00) ·
DATA-AM(FB/F8) · 128 data · CRC(2) · WG-off · GAP3`. Track prologue: GAP4A + index sync +
index AM (`FC`) + GAP1. The **ID field is 4 bytes: track, 0, sector, 0** followed by 2 CRC
bytes; the data field is 128 bytes + 2 CRC. The mini FM format (18 sectors) uses shorter gaps
(GAP1=16, SYNC=4/6, GAP3=16, GAP4B=103) but the same field structure.

### Density / bit-rate lines (PDS)

The DIO tells the PDS the data rate through CLK A / CLK B (driven from OC4 density bits):

| CLK B | CLK A | Format |
|-------|-------|--------|
| 0 | 0 | FM 125 kHz (mini) |
| 1 | 0 | FM 250 kHz (standard SD) |
| 1 | 1 | MFM 500 kHz (standard DD) |
| 0 | 1 | Not used |

---

## Physical Drive Parameters

### Shugart SA400 Minifloppy (the drive shipped with this manual)

| Parameter | Value |
|-----------|-------|
| Tracks | 35 (0–34), 48 TPI |
| Sectors/track (soft, this firmware) | 18 |
| Bytes/sector | 128 |
| Bits/track | ~25,000 |
| Encoding | FM, 125 kHz (8 µs/bit-cell) |
| Rotation | **300 RPM (200 ms/revolution)** |
| Sides | 1 |
| Track-to-track access | ~40 ms (stepper does **2 motor steps per track**, 2nd step ~13 ms after 1st) |
| Motor spin-up delay | **~1 second** after Motor-On before read/write |
| Formatted capacity | 35 × 18 × 128 = **80,640 bytes** (~78 KB) |
| Sectoring | Soft-sectored (single index hole; AMs delimit sectors) |

The stepper is 4-phase; phases A and C are the on-track positions, B and D are transient (the
hardware forbids writing during transient phases). Direction line low = step **in** (toward
higher track), high = step **out** (toward track 0). Track-00 is signalled by a microswitch.

### Standard drives

| Drive | Tracks | SD sectors | DD sectors | Density |
|-------|--------|-----------|-----------|---------|
| Shugart SA800 / GSI-110 | 77 (0–76) | 26 | 58 | FM 250 kHz / MFM 500 kHz |
| PERSCI 270 (dual) | 77 | 26 | 58 | FM / MFM, 2-sided |

SA800/GSI SD capacity ≈ 77×26×128 = **256,256 bytes**; DD ≈ 77×58×128 = **570,368 bytes**.

---

## Comparison with the MITS 88-DCDD (why the emulation strategy differs)

| Aspect | MITS 88-DCDD | IMSAI MDC-DIO |
|--------|--------------|---------------|
| Software interface | 3 **I/O ports** (`IN`/`OUT` per byte) | **Memory window `E000–EFFF`** + firmware `CALL`s |
| Data transfer | Programmed I/O, poll status bit per byte, **32 µs window** the CPU must meet | Firmware + **hardware WAIT states**; CPU is stalled by the bus, no per-byte polling in user code |
| Sectoring | **Hard-sectored** (sector holes in media) | **Soft-sectored** (address marks) |
| Head/track logic | Software tracks position, issues step pulses | **Firmware** does all seeking, remembers head position |
| Error recovery | Software's job | **Firmware** retries (3× reseek, 20× CRC) internally |
| What the OS sees | A register interface | **A subroutine** returning a status byte |
| ROM on card | None | **2 KB firmware ROM** is the whole point |

**Implication for 8sim:** the 88-DCDD is naturally modeled as an `IIODevice` with three ports
and a byte-clock. The MDC-DIO is naturally modeled as an **`IMemory` region** covering
`E000–EFFF`, plus a tiny `IIODevice` for the `XE`/`XF` enable ports.

---

## Virtualizing the MDC-DIO in 8sim

### Recommended approach: firmware-API emulation (a "fake ROM")

You almost certainly do **not** have the original 2716 firmware image, and even if you did,
bit-accurate 8255/PDS/serializer emulation is a large effort for little benefit. The high-value
target is **the subroutine contract**, which is fully specified above. Emulate the *behavior of
the firmware*, not the silicon.

Model the board as a single `IMemory` region for `E000–EFFF` backed by TypeScript, plus a
2-port `IIODevice` for enable/disable:

1. **Expose the 4 KB window as an `IMemory` region** sorted into the `BusRegion[]` list.
   - `E000–E00E`: a small stub ROM. At each entry point place a recognizable trap. The cleanest
     trick that needs no CPU changes: put a **`JMP` to a per-entry trampoline that ends in a
     one-byte opcode the host watches for**, or simpler — have the host **intercept `CALL`
     targets**. The most portable option in this architecture is a **`HLT`-trap or an
     out-of-range `RST`/`OUT`-to-magic-port trampoline**, but the least invasive is:
   - Put real bytes `C3 xx xx` at `E000/E003/E006/E009/E00C` pointing at a **handler page inside
     the window** (say `E010`). At `E010` place a single sentinel opcode. In `Cpu8080.step()` you
     already fetch opcodes through the bus — implement the handler as a **memory-read side effect**:
     when the CPU fetches from the sentinel address, the `IMemory.read()` runs the firmware
     operation in TS, writes the status into `A` **via a callback into the CPU/bus**, and returns
     a `RET` (`C9`) so control flows back to the caller. (8sim's `MemoryMappedIOAdapter` and the
     existing firmware-style skills show the pattern of a memory region with live side effects.)
   - Alternatively, and most simply: **intercept the `CALL` in the host** by having the machine
     wire a hook so that a `CALL` to `E006/E009/E00C` invokes a native handler that reads `A`,
     performs the operation against the backing disk image, sets `A`/flags, and returns — never
     executing ROM at all. This keeps the CPU core untouched if you route it through the bus, or
     add a tiny "call trap" table if you're willing to special-case it.
   - `E800–E8FF`: back with a real 256-byte `Uint8Array`. Reads/writes hit it directly. INIT
     seeds `E800–E806` from the (virtual) switch settings and loads the pointer defaults.
   - `E900–EFFF`: for the API-level model these are **unused** (the firmware, not the guest,
     touched them). You may leave them as no-op reads/writes returning `0xFF`/ignoring writes.

2. **Implement INIT (`E00C`)**: populate `E800–E806` per configured drive types, write the 16
   pointer defaults into wherever your model keeps the pointer table, mark the board ready.

3. **Implement the Byte Commands** (`E006`/`E009`):
   - `0X`: fetch pointer X's address from the pointer table, read the 4–7 byte Command String
     from **main memory** (via `IBus.read`), dispatch on Byte1's upper nibble.
   - `1X`: capture the next two `CALL`s' `A` values as LOW/HIGH and store into pointer X. (Model
     a tiny 3-state machine, or read the two following bytes however your trap mechanism exposes
     them.)
   - `2X`/`3X`/`4X`: update per-drive restore/write-protect flags for the masked drives.
   - Standard vs. mini entry only changes which drive table (`E800–E803` vs `E804–E806`) and
     geometry you validate against.

4. **Implement the Command String operations** against a backing disk image (flat
   `tracks × sectors × 128` array, or a `.dsk`/IMD/`.imd` file):
   - **Read (2)**: validate track/sector/buffer; copy 128 bytes from the image into main memory
     at Byte6/7 via `IBus.write`; set status.
   - **Write (1)**: honor software/hardware write-protect (`A2`/`A3`); copy 128 bytes from memory
     to the image.
   - **Format (3)**: clear/initialize the whole track in the image (fill data with `E5`).
   - **Verify (4)**: validate without transferring.
   - **Deleted mark (5)**: flag the sector's data AM as deleted; subsequent reads return `97`.
   - Always **write the status byte back into Byte2 of the string in main memory** *and* return
     it in `A`. Success = `01`; errors per the code table.

5. **Enable/disable ports (`XE`/`XF`)**: a 2-port `IIODevice`. `OUT XF` → mark region active;
   `OUT XE` → mark inactive (and let an overlapping RAM region win). If your machine has no
   RAM overlapping `E000–EFFF`, you can treat the board as always-enabled and make these ports
   harmless no-ops. Make `X` configurable (default `X=E`, ports `EE`/`EF`, matching a stock
   IMSAI). Reset leaves the board **enabled** (trace L→M default).

6. **Bootstrap**: if you place a stub at `E000`/`E003`, its handler performs "read track 0
   sector 1 of drive 0 → `0x0000–0x007F`, then set PC = `0x0000`." An 8sim `boot-imdos` example
   would EXAMINE `E000` (or `E003`) and RUN, mirroring `examples/boot-cpm.ts`.

### Fidelity checklist (behaviors worth reproducing)

- **Status word semantics** (bit 7 = error, `01` = success) — OS BIOSes test exactly this.
- **`E0` buffer-high rejection** → `C7`; **no-drive / multi-drive** → `C2`/`C3`; out-of-range
  track/sector → `C5`/`C6`. Real OSes probe these.
- **Deleted-data mark → `96`/`97` with data still delivered** (don't abort the transfer).
- **Drive-type bytes at `E800–E806` are live**: honor a program that pokes them to switch
  density/geometry mid-run.
- **Write-protect state**: software WP set by cmd `3X`, cleared by `4X`; power-up = enabled.
- **Pointer table**: cmd `1X` must actually change where cmd `0X` looks. Default table matters
  for code that assumes pointer 0 = `0080`.
- **1-based sector numbering** in the Command String.
- **Reset behavior**: after RESET the guest must call INIT (`E00C`) before other commands; you
  may either require it (return an error/garbage until INIT, like the real board) or auto-INIT.

### If you must run the genuine firmware ROM

Then implement the bare-hardware level: two `IIODevice`/`IMemory`-mapped 8255s with
**readable write-only shadow** semantics, the three WAIT-sync addresses (`EB00`/`ED00`/`EE00`)
that must return bytes in lock-step with a modeled rotational bit clock, the CRC generator, the
address-mark comparator fed by the OC1/OC2 clock-recognition bits, and PDS density selection.
This is the same order of complexity as the 88-DCDD's bit engine but larger, and requires a
dumped `2316/2716` image. **Prefer the firmware-API model unless bit-exact ROM execution is a
hard requirement.**

---

## Quick Reference Card

```
MEMORY WINDOW ....... E000-EFFF (4 KB), enabled at RESET
ENABLE/DISABLE ...... OUT XF = enable, OUT XE = disable (data ignored); X = board's I/O page
FIRMWARE ENTRIES:
  E000  boot from standard drive 0   (EXAMINE shows C3)
  E003  boot from mini drive 0
  E006  command entry, STANDARD drives   ; A = byte command, returns status in A
  E009  command entry, MINI drives
  E00C  INIT (call once after RESET)
RAM ................. E800-E8FF (E800-E806 = drive-type bytes; E880-E8FF = user free)
BYTE COMMAND  A = [CMD#<<4 | ptr/drivemask]:
  0X execute command-string ptr X   1X set ptr X (then CALL low, CALL high)
  2X restore drives(mask)  3X SW write-protect  4X SW write-enable   5-F nop
COMMAND STRING (RAM): B1=cmd<<4|drivebit  B2=status  B3=0  B4=track
                      B5=sector(1-based)  B6/B7=buffer addr (B7 != E0)
  cmd 1=WRITE  2=READ  3=FORMAT TRK  4=VERIFY  5=WRITE DELETED MARK
STATUS: bit7=error; 01=success. Cx=cmd-string err, Ax=recoverable, 9x=hardware.
GEOMETRY: mini 35trk x 18sec x 128;  std SD 77 x 26 x 128;  std DD 77 x 58 x 128
BOOT: track0/sector1/drive0 -> 0000-007F, JMP 0000
```
