# SKILL: The IMSAI FIF / FDS Floppy Disk Controller (IFM + FIB) — Behavior & Programming Model

## Overview

The **IMSAI Floppy Disk System (FDS)** — ordered as an **FIF** — is the 8" floppy
controller for the IMSAI 8080. Unlike the MITS 88‑DCDD (a dumb bit‑pump) it is an
**intelligent, DMA‑capable controller built from two S‑100 boards** plus firmware:

- **IFM — Interface Master.** A *complete second 8080* dedicated to disk control. It carries
  its own **8080 CPU, 512 bytes of RAM, 2 KB of EPROM firmware**, and all support logic.
  It talks to the main system through exactly **one output port** and a **DMA channel**.
- **FIB — Floppy Interface Board.** All the control logic that drives the floppy hardware
  (head load, step/direction, read/write, address‑mark sync) on behalf of the IFM processor.
  Not visible to host software.
- **Drive assembly:** CalComp **Model 140** 8" drive(s), **FPS** power supply, **FLB** light
  board, and **PLO** data separator (recovers clock/data, detects the IBM missing‑clock
  address marks). Up to **4 drives**.

**The single most important fact for an emulator: host software never touches disk
registers and never spins on a data‑ready bit.** The main CPU treats the whole floppy
system as **one 8‑bit output port** (`0xFD`). To do a disk operation it (1) builds a
**Command String** in its *own* main memory, (2) `OUT`s a one‑byte **Byte Command** to port
`0xFD`, and (3) polls a **status byte** inside that Command String until it goes non‑zero.
The IFM's firmware does everything else — head positioning, address‑mark sync, byte
transfer, CRC, retry — and moves the Command String, the 128‑byte data buffer, and the
final status byte **to and from main memory by DMA**, transparently to the main CPU.

Because of this there are two levels at which the FDS can be virtualized:

1. **The port/Command‑String API level** — the `OUT 0xFD` contract, the Command String
   layout in main RAM, the 16 pointer table, and the returned status word. This is what
   CP/M / IMDOS BIOSes and the bootstrap actually use. **For 8sim this is the level to
   emulate.**
2. **The bare‑hardware level** — actually running the real IFM 8080 firmware ROM, modeling
   the FIB's bit clock, PLO sync, missing‑clock detection and CRC hardware. You only need
   this to run the genuine EPROM image bit‑accurately.

Both are covered below; the emulation guidance at the end explains why the API level is the
practical target and how to wire it into 8sim's `IBus` model.

---

## Host interface: one output port + DMA

| Space | Address | Purpose |
|-------|---------|---------|
| **I/O (output)** | port **`0xFD`** | The IFM command port. Every host→controller action is an `OUT 0xFD`. |
| **Main memory (via DMA)** | anywhere the host puts it | Command Strings, the 128‑byte data buffer, and the status byte all live in **main system RAM** and are moved by the IFM's DMA channel. |

- **Port address is jumper‑selected** at socket **C3 on the IFM board**; the **IMSAI standard
  is `FD` hex**. (An 8‑position address‑select header; ship default = `FD`.)
- The port is **output‑only** from the host's point of view. The manual never does an `IN`
  from the controller — **all results come back via DMA** (the status byte in the Command
  String). Treat `IN 0xFD` as undefined/unused.
- **Do not confuse the FIF with the front‑panel sense switches.** The sample code reads the
  desired *drive number* with `IN 0FFH` — that is the **8080 front‑panel programmed‑input
  switches (port `0xFF`)**, not the controller. The FIF has nothing to do with port `0xFF`.

### DMA / bus‑sharing behavior (what the IFM does under the hood)

- On `OUT 0xFD` the IFM lowers the **main processor's READY line**, latches the output byte
  into its own accumulator, then raises READY again (a brief WAIT of the main CPU).
- To move a Command String or data, the IFM asserts **HOLD**; the system responds **HLDA**;
  the IFM three‑states the main CPU off the bus, drives its own address/data/status, DMAs a
  byte at a time (during the state after T3 of the main CPU's machine cycle), then releases
  HOLD. The main CPU keeps running between steals.
- Net effect the emulator must reproduce: the controller can **read from and write to
  arbitrary main‑memory addresses** — the Command String, the 128‑byte sector buffer, and
  the 1‑byte status result. In 8sim this means the device needs a reference to the **bus**,
  like the Dazzler DMA card.

---

## Two kinds of instruction

1. **Byte Command** — a single byte `OUT`ed to port `0xFD`, directly executed by the IFM.
2. **Command String** — a 4‑to‑9‑byte structure the host builds in main RAM; executed
   *indirectly* when a Byte Command `0X` is issued.

### The Byte Command byte

```
 bit7 bit6 bit5 bit4 | bit3 bit2 bit1 bit0
 <-- BYTE COMMAND # ->|<- POINTER # (0-15) or DRIVE-SELECT MASK ->
      (high nibble)          (low nibble)
```

| High nibble | Name | Low nibble means | Action |
|-------------|------|------------------|--------|
| **0** | **Execute Command String** | pointer # (0–15) | DMA the Command String pointed to by pointer *X* out of main memory and execute it. Pointer must have been set (cmd 1) or be a default. |
| **1** | **Set Pointer** | pointer # (0–15) | Take the **next two bytes** `OUT`ed to `0xFD` as **LOW then HIGH** address; store as pointer *X*. **3 bytes total:** `1X`, `LL`, `HH`. |
| **2** | **Restore Drive(s)** | drive‑select mask | Restore (seek to track 0) every drive whose bit is set. |
| **3** | **Set SW Write‑Protect** | drive‑select mask | Software write‑protect the selected drive(s). (On power‑up all drives come up WRITE‑ENABLED, so WP must be re‑set after every power cycle if wanted.) |
| **4** | **SW Write‑Enable** | drive‑select mask | Remove software write‑protect on selected drive(s). |
| **5**–**F** | *no‑op* | — | Do nothing, **except command `5` = Reset Interrupt** (the IMSAI standard reset‑interrupt command, used only in interrupt mode). |

**Drive‑select mask** (used by commands 2, 3, 4 *and* by the Command String's Byte 1): one
bit per drive — bit0=drive0, bit1=drive1, bit2=drive2, bit3=drive3. Exactly **one** bit
should be set for a data operation (0 selected → error; >1 selected → error).

### The 16‑entry pointer table

`pointer #` (0–15) selects one of **16 addresses** in the IFM that hold the main‑memory
address of a Command String. Byte Command `1X` writes a pointer; Byte Command `0X` executes
the string at pointer *X*. **On power‑up / RESET the 16 pointers initialize to these
defaults** (hex):

```
0: 0080   4: 4000   8: 8000   C: C000
1: 1000   5: 5000   9: 9000   D: D000
2: 2000   6: 6000   A: A000   E: E000
3: 3000   7: 7000   B: B000   F: F000
```

(Note pointer 0 defaults to `0x0080` — just above the 128‑byte area the bootstrap loads.)

---

## The Command String (in main RAM)

A Command String is **4 to 9 consecutive bytes**. First four are always present:

| Byte | Name | Meaning |
|------|------|---------|
| **1** | **Command byte** | high nibble = **command number** (operation, see table); low nibble = **drive‑select bit** (one of bits 0–3). |
| **2** | **Status byte** | **Host must set = 0 before issuing.** IFM writes it **non‑zero on completion** (via DMA). Bit 7 set ⇒ error; `01` ⇒ successful completion. Poll this to know the op is done. |
| **3** | **Track address, high** | Reserved for expansion — **must be 0** at present. |
| **4** | **Track address, low** | **Physical** track, **0–76** decimal. |
| **5–9** | command‑dependent | present as required by the command (see below). |

> For IBM‑media compatibility the *logical* track written into a sector's ID can differ from
> the *physical* track. Bytes 3–4 always carry the **physical** track; the logical‑track
> variants (commands 7–11) carry the logical track in the two bytes right after the base
> command's data.

### Command String command numbers (Byte 1 high nibble)

| # | Name | Extra bytes | Behavior |
|---|------|-------------|----------|
| **0** | **READ ALL** | B5 = delay ms (0–255), B6/B7 = buffer lo/hi | After the index pulse, delay B5 ms, then read **64 raw bytes**; for each, store the **data byte followed by its clock byte** → **128 bytes** to the buffer. For deciphering unknown/foreign formats. Use with caution. |
| **1** | **WRITE SECTOR** | B5 = sector (1–26), B6/B7 = buffer lo/hi | Write 128 bytes from buffer into the sector on track B4. |
| **2** | **READ SECTOR** | B5 = sector (1–26), B6/B7 = buffer lo/hi | Read the sector into the buffer; only transferred if CRC good. |
| **3** | **FORMAT TRACK** | *(none)* | Write a full IBM‑compatible format on track B4. **Destroys the whole track.** Required before first use of a new diskette. |
| **4** | **VERIFY SECTOR** | B5 = sector (1–26) | Read the sector and check its CRC. **No data transfer** to main memory. |
| **5** | **WRITE DELETED DATA (sector mark)** | B5 = sector | Write a *deleted data* address mark on the sector (marks a defective sector). |
| **6** | *(see firmware notes)* | — | *(gap between 5 and 7–11; verify against firmware section)* |
| **7–11** | **logical‑track variants of 1–5** | as 1–5, **plus** logical track in the two bytes following that command's data | Reference the **physical** track in B3/B4 but compare/write the **logical** track in the ID. E.g. a 4‑byte base command → logical track in bytes 5–6; a 7‑byte base command → logical track in bytes 8–9. |

**Geometry (IBM 3740, single density / FM):** 77 tracks (0–76), 26 sectors/track (**1–26**),
128 data bytes/sector → **1.94 Mbit** per diskette (256,256 bytes). Track 0 holds data‑set
labels. All track/sector numbers are **decimal**.

### Status word / error codes (Byte 2)

```
 bit7  bit6  bit5  bit4  bit3 bit2 bit1 bit0
  |     |     |     |     <-- error sub-code (low hex digit) -->
  |     |     |     +-- 1 = HARDWARE error
  |     |     +-------- 1 = RECOVERABLE system error
  |     +-------------- 1 = error in COMMAND STRING
  +-------------------- 1 = ERROR, 0 = NO ERROR
```

Successful completion writes **`01`** (bit 0 set, bit 7 clear). On error, bit 7 is set and
one of bits 6/5/4 classifies it; the **low hex digit** gives the specific sub‑code:

**Bit 6 — Command‑String error:** `1`=status byte wasn't 0 at init · `2`=no drive selected ·
`3`=more than one drive selected · `4`=illegal command number · `5`=illegal track address ·
`6`=illegal sector address · `7`=illegal data‑buffer location · `8`=illegal logical‑track #.

**Bit 5 — Recoverable system error:** `1`=selected drive not ready · `2`=drive is *hardware*
write‑protected and a write was attempted · `3`=drive is *software* write‑protected and a
write was attempted.

**Bit 4 — Hardware error:** `1`=drive not operable (couldn't reach track 0, or went
not‑ready mid‑op) · `2`=track‑address error (retried 10× repositioning) · `3`=data‑sync error
(couldn't find the sector within 2 revolutions) · `4`=CRC error in the ID field · `5`=format
error in the ID field · `6`=CRC error in the data field (retried 10×) · `7`=deleted‑data
address mark encountered while reading.

So e.g. `0x01` = success. `0xC4` = command‑string error, illegal command number. `0xA1` =
recoverable, drive not ready. `0x93` = hardware, data‑sync (sector not found). Emulators
should reproduce these exact codes — real BIOSes decode them.

### Firmware timing / retry behavior (for delay & interrupt modeling)

Behavioral emulation can treat operations as instantaneous, but if you model latency or
completion interrupts these are the real numbers:

- **Track‑address error:** the head is repositioned and the read retried **10×** before
  returning hardware code `2`.
- **Data CRC error:** the sector read is retried **10×** before returning hardware code `6`.
- **Sector search:** a sector must be found within **2 disk revolutions** or you get the
  data‑sync error (hardware code `3`).
- **READ ALL (cmd 0):** waits **B5 milliseconds (0–255)** after the index pulse, then the
  64 raw bytes it reads span roughly **2 ms** of media.
- The status byte is DMA'd back into Command‑String Byte 2 **only when the op completes**,
  so the host's polling loop is the natural completion signal.

---

## Programming sequence (the contract)

```
1. Set a pointer to your Command String (once):
      OUT 0xFD, 1X          ; X = pointer number
      OUT 0xFD, LL          ; low  byte of Command String address
      OUT 0xFD, HH          ; high byte of Command String address
2. Fill the Command String in RAM:
      B1 = (cmd<<4) | drivebit
      B2 = 0                 ; status MUST be zero
      B3 = 0                 ; track high
      B4 = physical track
      B5.. = sector / buffer / etc. per command
3. Issue the operation:
      OUT 0xFD, 0X           ; execute Command String at pointer X
4. Wait for completion:
      poll B2 until non-zero
      if (B2 & 0x80) handle error   ; else B2 == 0x01 success
```

---

## Bootstrap (IFM REV 3 firmware)

The REV‑3 firmware contains a bootstrap: **read sector 1 of track 0 from drive 0 into main
RAM at `0x0000`–`0x007F`, then jump to `0x0000`.** Operator sequence: insert system diskette
in drive 0, RESET, `EXAMINE 0000` (a **`C3`** — an 8080 `JMP` — appears in the data lights),
then **RUN**. On a hardware error the FIB error code is shown in the programmed‑output
(front‑panel) lights and the boot retries until it succeeds or is stopped. (If REV‑3 firmware
is absent, IMSAI CP/M ships a software Bootstrap Simulator instead.)

---

## Sample code (verbatim from the manual's System‑Test modules)

These are the manual's actual 8080 test routines. `IFMIO EQU 0FDH` (port `0xFD`).
Layout used: `BUFA` (128‑byte data buffer) = `1800H`; `CMD` (9‑byte Command String) =
`1880H`; program start = `1889H`. `IN 0FFH` reads the **front‑panel sense switches** for the
drive‑select mask (this is *not* the controller).

**Shared "issue and wait" + setup (Test Module 1 — continuously FORMATs track 0):**
```asm
BUFA   EQU  1800H
IFMIO  EQU  0FDH            ; IFM I/O port
CMD    EQU  1880H          ; Command String (9 bytes)

ISSUE: SUB  A              ; A = 00  -> Byte Command 0, pointer 0
       OUT  IFMIO          ; execute Command String at pointer 0
STLP:  LDA  CMD+1          ; get status byte (B2)
       ORA  A
       JZ   STLP           ; wait until status != 0
       RP                  ; return if no error (bit7 clear)
       OUT  0FFH           ; else show error status on front-panel LEDs
       JMP  BEGIN

START: LXI  SP,1BF3H
       SUB  A
       STA  CMD+2          ; B3 track-high = 0
       LXI  H,BUFA
       SHLD CMD+5          ; B6/B7 = data buffer address (lo,hi)
       MVI  A,10H          ; Byte Command 1, pointer 0  (set pointer 0)
       OUT  IFMIO
       LXI  H,CMD
       MOV  A,L
       OUT  IFMIO          ;   low  byte of CMD address
       MOV  A,H
       OUT  IFMIO          ;   high byte of CMD address
       IN   0FFH           ; drive number from sense switches
       ORI  20H            ; Byte Command 2 (Restore) | drive mask
       OUT  IFMIO
BEGIN: IN   0FFH           ; drive number
       ORI  30H            ; command 3 (FORMAT TRACK) | drive bit -> B1
       STA  CMD            ; B1 = command byte
       SUB  A
       STA  CMD+1          ; B2 status = 0
       STA  CMD+3          ; B4 track  = 0
       CALL ISSUE
       JMP  BEGIN
```

**Test Module 2 — WRITE track 0 / sector 1 from the buffer:**
```asm
       IN   0FFH
       ORI  10H            ; command 1 (WRITE SECTOR) | drive bit
       STA  CMD            ; B1
       SUB  A
       STA  CMD+1          ; B2 status = 0
       STA  CMD+3          ; B4 track  = 0
       INR  A
       STA  CMD+4          ; B5 sector = 1
       CALL ISSUE
```

**Test Module 3 — READ track 0 / sector 1 into the buffer:**
```asm
       IN   0FFH
       ORI  20H            ; command 2 (READ SECTOR) | drive bit
       STA  CMD            ; B1  (sector/buffer left from module 2)
       SUB  A
       STA  CMD+1          ; B2 status = 0
       CALL ISSUE
```

**Test Module 4 — FORMAT track 76 (exercises head positioning):**
```asm
       SUB  A
       STA  CMD+1          ; B2 status = 0
       MVI  A,4CH          ; 76 decimal
       STA  CMD+3          ; B4 track = 76
       IN   0FFH
       ORI  30H            ; command 3 (FORMAT TRACK) | drive bit
       STA  CMD            ; B1
       CALL ISSUE
```

(`CMD+0`=B1 cmd, `CMD+1`=B2 status, `CMD+2`=B3 track‑hi, `CMD+3`=B4 track‑lo,
`CMD+4`=B5 sector, `CMD+5/6`=B6/B7 buffer lo/hi.)

---

## Emulation guidance for 8sim

**Emulate at the port/Command‑String API level. Do not run the real IFM firmware.** The IFM
is a whole second 8080; there is no reason to simulate it cycle‑accurately when the host‑
visible contract is a single output port plus DMA into main RAM.

Model the card as an **`IIODevice` bound to port `0xFD`** that also **holds a reference to the
`IBus`** (for DMA), mirroring how the Dazzler DMA card reaches memory. Suggested shape:

1. **Port `0xFD` write handler = a small state machine.**
   - *Idle state:* decode the byte. `cmd = byte>>4`, `low = byte & 0x0F`.
     - `0` → `executeCommandString(pointer[low])`.
     - `1` → enter *set‑pointer* state for pointer `low`; the next two writes are `LL`, `HH`.
     - `2` → for each drive bit set in `low`, set that drive's head/track to 0.
     - `3`/`4` → set/clear the software write‑protect flag for the masked drive(s).
     - `5`–`F` → no‑op (optionally, `5` clears a pending interrupt).
   - *Set‑pointer state:* first following write = LOW, second = HIGH → `pointer[n] = HH<<8|LL`;
     back to idle.
   - `IN 0xFD` → undefined; return `0xFF` (host never reads it).
2. **`executeCommandString(addr)`** — via `IBus.read`:
   - Read `B1..` from main memory at `addr`. `op = B1>>4`, `drivemask = B1 & 0x0F`.
   - Validate: status‑byte (B2) must be read as 0 at init? (real board checks — see bit‑6
     code `1`); exactly one drive bit set (else `C2`/`C3`); track B3==0 and B4 ≤ 76 (else
     `C5`); command number legal (else `C4`).
   - Dispatch on `op`:
     - **1 WRITE** — honor WP (`A2` hardware, `A3` software); copy 128 bytes from main memory
       at `B6/B7` into the image at (drive, B4, B5).
     - **2 READ** — copy 128 bytes from the image to main memory at `B6/B7`.
     - **3 FORMAT** — reinitialize track B4 in the image (fill data `E5`).
     - **4 VERIFY** — validate (drive/track/sector, CRC) without transfer.
     - **5 WRITE DELETED** — flag the sector's data AM deleted; later reads yield code `97`.
     - **0 READ ALL** — rarely needed; can be stubbed unless a guest uses it.
     - **7–11** — as 1–5 with a logical‑track field; for a flat image you can treat logical
       == physical unless you model ID‑field track values.
   - **Write the status back**: `IBus.write(addr+1, status)` — `0x01` on success, else the
     error code from the tables. Return promptly (model it as instantaneous, or schedule a
     short delay and optionally raise a PIC interrupt on completion).
3. **State to keep:** 16‑entry `pointer[]` (init to the default table on reset), per‑drive
   `{ track, softwareWriteProtect }`, and per‑drive backing images.
4. **Backing image:** flat `77 × 26 × 128 = 256,256` bytes per drive matches the existing
   `imdos202.dsk` fixture and the repo's other disk tests. Sector numbers are **1‑based**.
5. **Bootstrap example:** an 8sim `boot-imdos` example can either preload the REV‑3 boot ROM
   behavior or just synthesize it — read (drive 0, track 0, sector 1) → `0x0000–0x007F`,
   set PC = `0x0000` — mirroring `examples/boot-cpm.ts`.

### Fidelity checklist (behaviors worth reproducing)

- **Port is `0xFD`, output‑only; results come back only via DMA into the Command String.**
- **Status‑byte protocol:** host writes B2=0, controller writes non‑zero; bit7=error,
  `0x01`=success. OS BIOSes poll exactly this.
- **Exact error codes** (`Cx` command‑string, `Ax` recoverable, `9x` hardware) — real code
  decodes them.
- **16‑pointer indirection with the default table** — code assumes pointer 0 = `0x0080`.
- **Set‑pointer is a 3‑byte `OUT` sequence** (`1X`, LL, HH).
- **Drive‑select mask semantics:** 0 drives → `C2`, >1 → `C3`.
- **1‑based sector numbering (1–26); tracks 0–76; all decimal.**
- **Write‑protect:** power‑up = write‑enabled; `3X` sets SW‑WP, `4X` clears it; write to a
  WP'd drive → `A2`/`A3`.
- **Reset / power‑up:** the firmware **restores every drive** (heads → track 0) **and
  re‑initializes the 16 pointers** to the default table. Reproduce both.
- **Don't confuse port `0xFF` (front‑panel sense switches, used by sample code for the drive
  number) with the controller.**

### If you must run the genuine IFM firmware ROM

Then emulate the *bare‑hardware* level: a second 8080 core running the 2 KB EPROM with 512 B
RAM, the FIB's step/direction/head‑load/write‑enable control lines, the PLO data separator
with IBM‑3740 **missing‑clock** address‑mark detection (all significant missing‑clock
patterns have the gap in bit 5), FM (double‑frequency) bit encoding, and CRC. This is
strictly harder than the 88‑DCDD bit engine and needs a dumped IFM EPROM image. **Prefer the
API‑level model unless bit‑exact ROM execution is a hard requirement.**

---

## Quick Reference Card

```
CONTROLLER .......... IMSAI FDS "FIF" = IFM (8080+512B RAM+2K EPROM) + FIB, DMA-capable
HOST PORT ........... OUT 0xFD only (jumper C3 on IFM; IMSAI std = FD hex). Results via DMA.
                      (port 0xFF in sample code = front-panel sense switches, NOT the FIF)
BYTE COMMAND  OUT 0xFD, [cmd<<4 | ptr-or-drivemask]:
  0X exec Command String at pointer X
  1X set pointer X  -> then OUT LL, OUT HH   (3-byte sequence)
  2X restore drives(mask)  3X SW write-protect  4X SW write-enable
  5..F nop  (5 = reset-interrupt in interrupt mode)
POINTERS (16) default: 0:0080 1:1000 2:2000 3:3000 ... F:F000
COMMAND STRING (main RAM, 4-9 bytes):
  B1 = cmd<<4 | drivebit    B2 = status (host=0; ctrl writes non-zero)
  B3 = 0 (track hi)         B4 = physical track 0-76
  B5 = sector 1-26          B6/B7 = data buffer addr (lo,hi)
  CMD #:  0 READ-ALL  1 WRITE-SEC  2 READ-SEC  3 FORMAT-TRK
          4 VERIFY-SEC  5 WRITE-DELETED  7-11 = 1-5 logical-track variants
STATUS: bit7=error; 0x01=success. C_=cmd-string err, A_=recoverable, 9_=hardware.
GEOMETRY: 77 trk (0-76) x 26 sec (1-26) x 128 B, IBM 3740 FM single density (256,256 B).
BOOT (REV3): drive0 track0 sector1 -> 0000-007F, JMP 0000 (EXAMINE 0000 shows C3, RUN).
```
