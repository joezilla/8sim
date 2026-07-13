# SKILL: Programming the Processor Technology 3P+S I/O Module in 8080 Assembly

## Overview

The **Processor Technology 3P+S Input/Output Module** (1976) is an S-100 bus
multifunction I/O card. The name means **3 Parallel + Serial**: it provides
**two general-purpose 8-bit parallel data ports** (Channels A and B), **one
parallel control/status port** (Channel C), and **one asynchronous serial port**
(Channel D) built around a general-purpose UART. It occupies **four consecutive
I/O port addresses** and is one of the most common I/O boards used with the
Altair 8800, the **IMSAI 8080**, and the Processor Technology Sol-20.

It is the direct ancestor of the serial section of the Sol-20 and the assumed
I/O board for much early Processor Technology software (the ALS-8 executive,
SOLOS/CUTER-family monitors, etc.). Unlike the later single-chip ACIA boards
(MITS 88-2SIO / MC6850, IMSAI SIO-2 / 8251), the 3P+S is built from a discrete
**general-purpose UART** (AMI **S1883** / GI **AY-5-1013** / TI **TMS6011**) plus
TTL glue, and it exposes an unusually **jumper-defined, wire-your-own** register
model. This flexibility is the single most important thing to understand when
emulating it: **almost nothing about the bit layout is fixed in silicon — it is
defined by solder jumpers in "Areas" A–J on the board.**

**Key design facts for emulation:**
- **Port-mapped I/O**, 4 consecutive ports. IN and OUT at the same address hit
  *different* logic (separate input path and output latch), exactly like the
  8080 IN/OUT split.
- The **status word** read from Channel C is an arbitrary user-wired collection
  of UART flags and parallel-port handshake flags. There is **no hardware-fixed
  bit position** for TBE/RDA/errors — the board brings each flag to a terminal
  strip (Area G) and the builder jumpers it to whichever data bit they like.
- The **control word** written to Channel C is split: high nibble (bits 4–7)
  drives the UART configuration inputs (word length / parity / stop bits); low
  nibble (bits 0–3) drives latched control outputs (RTS, a relay/lamp driver,
  and a 2-way software baud-rate select).
- **Baud rate** is set by an on-board programmable divider (jumper-preset), with
  optional **2-rate software selection** via control bits 2–3.
- **Interrupts** are an *option* requiring a separate Processor Technology
  Vectored Interrupt Module; the stock board is **polled**.

---

## Hardware Overview

| Parameter | Value |
|-----------|-------|
| Bus | S-100 (Altair/IMSAI compatible) |
| UART | AMI S1883 = GI AY-5-1013 = TI TMS6011 (general-purpose UART, pin/function compatible) |
| Serial ports | 1 (Channel D), RS-232-C, 20 mA current loop, or TTL |
| Parallel ports | 2 × 8-bit bidirectional (Channels A, B) + 1 control/status (Channel C) |
| I/O ports consumed | **4 consecutive** (one per channel) |
| Address range | Any of **64 four-port groups** in the 256-port I/O space (A2–A7 jumpered) |
| Within-group order | Jumper-selectable: parallel-low `[A,B,C,D]` or serial/control-low `[C,D,A,B]` |
| Baud rates | 35 – 9600 baud (on-board programmable divider off 2 MHz Φ2; ÷N to 16× baud) |
| Data format | 5/6/7/8 data bits, 1/1.5/2 stop bits, odd/even/no parity (jumper or software) |
| Serial config | Static (hardwired jumpers) **or** dynamic (written from control port bits 4–7) |
| Parallel handshake | Per-port data-available latch (FA/FB), acknowledge out (AKA/AKB), device-ready in (XDRA/XDRB), output strobes |
| Interrupts | Optional, via Vectored Interrupt Module on VI0–VI7 (IC19 + Area G ribbon jumper) |
| Connectors | J1 = 3P+S outputs (44-pin), J2 = inputs to 3P+S (44-pin) |

---

## The Four Channels

The board decodes its 4-port window into four **channels**. Each channel address
behaves differently for IN vs. OUT:

| Channel | On `IN` (read) | On `OUT` (write) |
|---------|----------------|------------------|
| **A** | Parallel **input** port A (8 bits from J2), clears data-available flag FA | Parallel **output** latch A (8 bits to J1) + strobe pulse on J1 |
| **B** | Parallel **input** port B (8 bits from J2), clears data-available flag FB | Parallel **output** latch B (8 bits to J1) + strobe pulse on J1 |
| **C** | **Status word** — user-wired UART + handshake flags | **Control word** — UART config (bits 4–7) + latched control outputs (bits 0–3), fires the C strobe / UART CRL |
| **D** | **UART receive** data register (received char), clears RDA | **UART transmit** holding register (char to send) |

**Naming caution:** the 3P+S's Channels A/B/C/D are *board channels*, unrelated to
the "EIA A/B/C/D" inputs (the four RS-232 receiver inputs) also mentioned in the
manual. Keep them separate.

---

## I/O Port Map and Address Selection

### Group base address (Area A)

Six jumpers on address lines **A2–A7** select which of the 64 four-port groups
the board answers. Each jumper ties its address line to **V** (compared as 1) or
**G** (compared as 0). The board responds when A2–A7 match and A0/A1 pick the
channel. Example from the manual: A2–A7 all grounded → group at ports 0–3;
setting A2=V → group 4–7; etc. Port group **0xFC–0xFF (374–377 octal) is
reserved for the front-panel sense switches** — never place the board there.

```
Port address = (A7..A2 jumpered group base) | (A1 A0 channel select)
```

### Within-group channel order (Area B)

Area B decides whether the **parallel pair** or the **UART/control pair** occupies
the low two addresses of the group:

| A1 | A0 | Area B "left→center" | Area B "left→right" |
|----|----|----------------------|---------------------|
| 0  | 0  | A (parallel)         | C (control/status)  |
| 0  | 1  | B (parallel)         | D (UART data)       |
| 1  | 0  | C (control/status)   | A (parallel)        |
| 1  | 1  | D (UART data)        | B (parallel)        |

- **"left→center"** → group is `[A, B, C, D]` (parallel ports low). Processor
  Technology's serial software and the Appendix-V *parallel* test use this only
  when they want the parallel ports at the bottom.
- **"left→right"** → group is `[C, D, A, B]` (control + UART low). **This is the
  layout Processor Technology serial software assumes**, because it puts
  `STATUS = base+0` and `UART data = base+1`.

The Appendix-V **serial** test hard-codes:
```asm
STATUS EQU 0        ; Channel C status/control at group base+0
PORT1  EQU 1        ; Channel D UART data at group base+1
```
i.e. group base 0, `[C, D, A, B]` order → **status/control = port 0, serial data
= port 1**, parallel A = port 2, parallel B = port 3.

### Standard address examples

| Config | Group base | C (ctrl/status) | D (serial data) | A (par) | B (par) |
|--------|-----------|-----------------|-----------------|---------|---------|
| Serial-low at group 0 (test programs) | 0x00 | 0x00 | 0x01 | 0x02 | 0x03 |
| Serial-low at group "34h" style | 0x04 | 0x04 | 0x05 | 0x06 | 0x07 |
| Parallel-low (`[A,B,C,D]`) at group 0 | 0x00 | par A 0x00 | par B 0x01 | ctrl 0x02 | data 0x03 |

> When translating old listings, remember Processor Technology and MITS docs use
> **octal**. `000/001/002/003` octal = `0x00/0x01/0x02/0x03`.

---

## Channel C — Status Word (read with `IN`)

Reading Channel C returns an 8-bit **status word** assembled from whatever
signals the builder jumpered onto the C0–C7 terminals in **Area G**. Available
sources:

**UART flags** (from the AY-5-1013 status outputs):
- **TBE** — Transmitter Buffer Empty (a.k.a. TBMT). High ⇒ the transmit holding
  register can accept a new byte. This is the "OK to send" bit.
- **RDA** — Receiver Data Available (a.k.a. DAV). High ⇒ a received character is
  waiting in Channel D. This is the "character ready" bit.
- **OE** — Overrun Error. A new char arrived before the previous one was read.
- **FE** — Framing Error. Expected stop bit missing (usually wrong baud rate).
- **PE** — Parity Error (only meaningful when parity is enabled).

**Parallel channel flags:**
- **FA / FB** — data-available latch for parallel port A / B (set by the external
  device pulsing XDAA/XDAB low; cleared by reading that parallel port).
- **XA / XB** — the raw XDRA / XDRB "external device ready" input for port A / B
  (used for *output* handshaking: is the downstream device ready for more?).

**EIA inputs A/B/C/D** — the four RS-232 receiver inputs, e.g. carrier-detect
from a modem can be jumpered to a status bit.

> **There is no fixed bit assignment.** Each of the above is a wire you route to a
> chosen data bit. In an emulator this must be a **configurable mapping** with a
> sensible default.

### The two conventions you will actually meet

**1. Processor Technology "native" convention (Appendix V, PT software):**
```asm
TBE  EQU 80h        ; bit 7 = Transmitter Buffer Empty
RDA  EQU 40h        ; bit 6 = Receiver Data Available
; OE, FE, PE jumpered to other spare bits as desired
```
Polling with this layout:
```asm
        IN  STATUS      ; read Channel C
        ANI 80h         ; TBE? (ready to transmit)
        ...
        IN  STATUS
        ANI 40h         ; RDA? (character received)
```
Because TBE is bit 7 and RDA is bit 6, PT code frequently uses `RLC` to shift
bit 7 (TBE) or bit 6 (RDA) into carry.

**2. IMSAI-SIO-2-emulation convention (rewired for compatibility):**
Builders who wanted their 3P+S to look like an IMSAI **SIO-2** (Intel 8251) or a
MITS 88-2SIO to existing software rewired Area G so that:
```
bit 0 = TBE (transmitter ready)     bit 1 = RDA (receiver ready)
bit 2 = TBE (transmitter empty)     bit 3 = PE
bit 4 = OE                          bit 5 = FE
bits 6-7 = unused (float high)
```
This lets `ANI 01h`/`ANI 02h` style polling (2SIO/SIO-2 idiom) work. See the
IMSAI section below — this also requires inverting A0.

---

## Channel C — Control Word (write with `OUT`)

Writing Channel C latches an 8-bit control word and fires the **C output strobe**
(J1 pin L). If Area C is jumpered "strobe" mode, that same event pulses the UART
**CRL (Control Register Load)**. The byte is split into two independently-wired
nibbles:

### Bits 4–7 → UART configuration inputs (via Area H)

These four bits are routed (Area H jumpers) to the UART's five configuration
inputs. All are **active-high**:

| UART input | Meaning |
|------------|---------|
| **PI** (Parity Inhibit / NP) | High ⇒ no parity bit sent, receiver parity check disabled |
| **SBS** (Stop Bit Select / TSB) | Low ⇒ 1 stop bit; High ⇒ 2 stop bits (1.5 if 5-bit word) |
| **WLS1** (NB1) + **WLS2** (NB2) | Word length select (below) |
| **EPE** (Even Parity Enable / EPS) | High ⇒ even parity (when parity not inhibited) |

Word length:

| WLS1 | WLS2 | Data bits/char |
|------|------|----------------|
| H | H | 8 |
| L | H | 7 |
| H | L | 6 |
| L | L | 5 |

(There are 5 config inputs but only 4 control bits, so the builder either
hardwires some inputs or shares/omits one — commonly PI, SBS, WLS1, WLS2 are
software-driven and EPE is jumpered fixed, or vice-versa.)

**CRL behavior (critical for emulation):** if Area C jumpers CRL to the Channel-C
strobe, then the UART config latch is reloaded from bits 4–7 **on every OUT to
Channel C**. Therefore software must present the *correct, unchanging* config in
bits 4–7 on every control write, or it will silently corrupt the UART word
format. If Area C ties CRL high (center terminal), the config is **static** —
taken once from the Area H hardwiring and never touched by software. Emulate both
modes; default to static unless dynamic config is requested.

### Bits 0–3 → latched control outputs (IC6, via Areas E/F/J)

| Bit | Destination(s) | Typical function |
|-----|----------------|------------------|
| **0** | Area J row 2 (EIA out), Area F left (peripheral driver) | **RTS** (Request To Send) in RS-232 config; or drive a lamp/relay |
| **1** | Area J row 4, Area F right | Alternate peripheral-control-driver source |
| **2** | Area E terminal G (baud select) | Baud-rate select bit (see below) |
| **3** | Area E terminal H, Area J row 3 | Baud-rate select bit / EIA out |

**Peripheral Control Driver** (Area F): a high-current open output for lamps or
relays, driven by bit 0 **or** bit 1 (selected by how resistor R10 is wired).

**Software baud selection** (Areas E): when the divider is jumpered for two rates,
bits 2 and 3 pick between them:

| Bit 2 | Bit 3 | Baud rate |
|-------|-------|-----------|
| 0 | 1 | "bottom" (second) preset rate |
| 1 | 0 | "top" (first) preset rate |

Only **two** rates are software-selectable this way without extra parts.

---

## Channel D — UART Serial Data

### Transmit (`OUT` to Channel D)

Writing Channel D loads the byte into the UART **Transmit Holding Register**
(THR) via the THRL strobe. The UART then serializes it (start bit, data bits,
optional parity, stop bit(s)) at the configured baud rate.

- **TBE** (status) drops **false** the moment a byte is loaded into a full
  pipeline and rises **true** when the holding register is free again. Software
  must wait for TBE before each write, or the un-transmitted byte is overwritten.
- The separate "transmitter completely empty" condition (UART TRE pin) means the
  shift register *and* holding register are both idle.

### Receive (`IN` from Channel D)

Reading Channel D returns the byte in the UART **Receive Holding Register** (RHR)
and pulses **DRR (Data Received Reset)**, which clears **RDA**.

- **RDA** (status) goes **true** when a full character has been assembled and
  latched into the RHR; reading Channel D clears it (via DRR).
- If a new character completes while RDA is still true (previous char unread),
  **OE (Overrun)** sets and the old character is lost.
- **FE / PE** accompany the character currently in the RHR.
- The high bit of a received byte may be a parity bit or noise; ASCII software
  usually masks with `ANI 7Fh`.

### The underlying UART (S1883 / AY-5-1013 / TMS6011)

A classic general-purpose UART with **independent** transmit and receive
sections and a small status register. Relevant pins/functions the 3P+S exposes:

| UART signal | Pin | Role as wired on 3P+S |
|-------------|-----|-----------------------|
| RDA / DAV | 19 | Receiver Data Available → status |
| DRR | 18 | Data Received Reset — pulsed by IN Channel D |
| RDE | 4 | Receiver Data Enable — gates RHR onto the data-in bus for IN Channel D |
| TBE / TBMT | 22 | Transmit Buffer Empty → status |
| THRL | 23 | Transmit Holding Register Load — pulsed by OUT Channel D |
| TRE | 24 | Transmitter (shift) empty |
| PE / FE / OE | 13/14/15 | Parity/Framing/Overrun error → status |
| SWE | 16 | Status Word Enable |
| NB1/NB2, NP, EPS, TSB | 37/38/35/39/36 | Word-length / parity / stop config (from control bits 4–7) |
| CRL | 34 | Control Register Load (from Channel-C strobe or tied high) |
| RCP / TCP | 17/40 | Receiver/Transmit clocks — driven at **16× baud** from the divider |
| XR | 21 | External (master) reset |

There is **no software "master reset" register** the way an MC6850/8251 has —
reset comes from the S-100 reset line (XR). So, unlike the 2SIO, 3P+S init does
**not** begin with a "write 03h master-reset" step. Init is: set the desired
config (statically via jumpers, or by writing bits 4–7 of the control port if
dynamic), select baud, then poll TBE/RDA.

---

## Channels A & B — Parallel Ports with Handshaking

Each parallel channel is an independent 8-bit input port and 8-bit output latch
sharing one address (IN vs OUT).

### Output side (`OUT` to A or B)

- Latches 8 bits to the J1 output pins for that port.
- Generates an **output strobe** pulse (J1 pin 9 = strobe A, J1 pin K = strobe B)
  to tell the external device that new data is present.
- **XDRA / XDRB** (J1 pin 20 / pin X, "external device ready") are *inputs* the
  program can read as status bits (XA/XB) to implement output handshaking:
  wait until the device is ready, then OUT, which strobes it.

### Input side (`IN` from A or B)

- Returns the 8 bits currently on the J2 input pins for that port.
- The external device signals "new data available" by pulsing **XDAA / XDAB**
  (J2 pin 14 / pin R) **low**. This sets flip-flop IC15 → status flag **FA / FB**.
- When the latch sets, a high-active **AKA / AKB** ("acknowledge", J2 pin 13 /
  pin P) is presented to the device — usable as the clock for an external data
  latch. Data must be held stable at the inputs from flag-set until the program
  reads it (**an external data latch is required** on the peripheral side).
- **Reading the parallel port clears its FA/FB flag.** So the handshake is:
  device pulses XDAA → FA set (AKA asserted) → program polls Channel C, sees FA →
  program does `IN A` → FA cleared, ready for next byte.

This is exactly how a parallel keyboard (e.g. the CT1024 TV Typewriter II
keyboard) attaches: keystroke strobes XDAB, sets FB, program polls FB in the
status word, reads Channel B for the ASCII code.

---

## Baud Rate Generator

IC7/IC8/IC9 (93L16 counters) form a **programmable divide-by-N** off the 2 MHz
Φ2 clock, producing a clock at **16× the baud rate** (the UART requirement). The
modulus is a 12-bit preset jumpered in Area E. The manual tabulates presets for
35, 45.5, 50, 56.85, 61.12, 66.67, 74.23, 75, 110, 134.46, 150, 300, 600, 1200,
2400, 3600, 4800, and 9600 baud. Representative values:

| Baud | Modulus | Preset (dec) |
|------|---------|--------------|
| 110  | 1136 | 2949 |
| 300  | 417  | 3668 |
| 1200 | 104  | 3981 |
| 9600 | 13   | 4072 |

For a fixed installation the preset is hardwired. For two-rate operation, two
presets are wired and selected at run time by control bits 2–3 (above). In an
emulator, baud timing is normally irrelevant (characters transfer instantly), but
the *selected rate* may still be surfaced for realism/logging, and the config
determines framing so it should be modeled if framing-error emulation is wanted.

---

## Interrupts (Optional)

The stock 3P+S is **polled**. With the Processor Technology **Vectored Interrupt
Module** installed, IC19 and an Area-G ribbon jumper route selected UART flags or
handshake signals onto the S-100 **VI0–VI7** vectored-interrupt lines; any of the
UART error/handshake signals can be jumpered to raise an interrupt. The 8080
services it via the corresponding RST vector supplied by the interrupt module
(the CPU itself only sees the RST opcode jammed on the bus during the interrupt
acknowledge). Without the VIM there is no interrupt path — do not assume one.

For 8sim: model interrupts as an **opt-in** feature. Default device raises no
interrupts; when enabled, a chosen flag (e.g. RDA and/or TBE) asserts an
`IInterruptController` line, and the PIC supplies the RST vector as usual.

---

## Using the 3P+S in an IMSAI 8080

Electrically the 3P+S is a standard S-100 card and drops into an IMSAI chassis
unchanged. The only integration issues are **addressing** and **register order**:

1. **Front-panel switches:** the IMSAI (like the Altair) reads its sense switches
   from port **0xFF**. Keep the 3P+S group away from 0xFC–0xFF.

2. **Register order vs. IMSAI SIO-2.** IMSAI's own **SIO-2** board (Intel 8251)
   and most IMSAI/CP/M software expect **control/status and data** at a fixed
   order. The 3P+S's UART **control and data ports are reversed** relative to the
   SIO-2. With Area B "left→center" the parallel ports land at `0x00/0x01`, the
   UART **control** at `0x02`, and UART **data** at `0x03` — but the SIO-2
   ordering is the opposite within the UART pair. The classic fix is to **invert
   address line A0** into the board (a spare 74LS04 gate) so the control/data pair
   swaps, making the 3P+S answer at the SIO-2's expected port order.

3. **Status bit layout.** SIO-2 / 8251 software polls transmitter-ready and
   receiver-ready in specific bit positions. To be drop-in compatible, rewire
   Area G so TBE and RDA land where the target software expects them (see the
   "IMSAI-SIO-2-emulation convention" above: TBE→bit0, RDA→bit1, etc.). This is a
   pure jumpering choice, not a hardware limitation.

**Emulation takeaway:** expose (a) the group base address, (b) the Area-B order
`[A,B,C,D]` vs `[C,D,A,B]`, (c) an optional A0-invert flag for SIO-2-style
ordering, and (d) the status-word bit map. With those four knobs the virtual
3P+S can impersonate both a "native" 3P+S and an SIO-2-compatible board.

---

## Programming Examples

All examples below assume the Processor-Technology serial layout
(`[C,D,A,B]` order): **Channel C status/control = base+0, Channel D data =
base+1**, and the **native** status bits **TBE = 0x80 (bit 7), RDA = 0x40
(bit 6)** — exactly the Appendix-V test program.

### EQUates

```asm
STATUS  EQU  0          ; Channel C — IN=status word, OUT=control word
PORT1   EQU  1          ; Channel D — IN=RX data, OUT=TX data
PORTA   EQU  2          ; Channel A parallel
PORTB   EQU  3          ; Channel B parallel
TBE     EQU  80h        ; status bit 7: transmitter buffer empty
RDA     EQU  40h        ; status bit 6: receiver data available
OE      EQU  20h        ; (wherever you jumpered it)
FE      EQU  10h
PE      EQU  08h
```

### Send a character (polled)

```asm
; Send char in A. Waits for TBE.
COUT:   MOV  B,A            ; hold char
COUT1:  IN   STATUS         ; read Channel C status word
        ANI  TBE            ; transmitter buffer empty?
        JZ   COUT1          ; no — wait
        MOV  A,B            ; restore char
        OUT  PORT1          ; load UART transmit register
        RET
```

The Appendix-V version uses restart routines: `RST 1` waits for TBE, `RST 2`
outputs the char in A. Reproduced verbatim from the manual:

```asm
        ORG  8
; -RST 1-  loop until TBE true
TBET:   IN   STATUS
        ANI  TBE            ; = 80h
        RNZ                 ; return when TBE goes true
        JMP  TBET
        ORG  10h
; -RST 2-  output char in A
COUT:   MOV  B,A
        RST  1             ; wait for TBE
        MOV  A,B
        OUT  PORT1
        RET
```

### Receive a character (polled)

```asm
; -RST 4-  wait until a char is available
CKIN:   IN   STATUS
        ANI  RDA            ; = 40h, receiver data available?
        RNZ                 ; return when true
        JMP  CKIN
; -RST 5-  read the char (this IN clears RDA via DRR)
CGET:   IN   PORT1
        RET
```

### Echo loop (serial round-trip test)

```asm
        ORG  0
LOOP:   IN   STATUS
        ANI  RDA            ; char received?
        JZ   LOOP
        IN   PORT1          ; read it (clears RDA)
        MOV  B,A
TXW:    IN   STATUS
        ANI  TBE            ; transmitter ready?
        JZ   TXW
        MOV  A,B
        OUT  PORT1          ; echo
        JMP  LOOP
```

### CR/LF

```asm
; -RST 3-  carriage return + line feed
CRLF:   MVI  A,0Dh
        RST  2             ; output CR
        MVI  A,0Ah
        RST  2             ; output LF
        RET
```

### Parallel port loopback tests (Appendix V, Tests 1 & 2)

```asm
; Test 1: copy front-panel sense switches (port FFh) to output ports A and B
LOOP:   IN   0FFh          ; sense switches
        OUT  PORTA         ; drive parallel output A
        OUT  PORTB         ; drive parallel output B
        JMP  LOOP

; Test 2: read a parallel input port, echo to its output latch
LOOP2:  IN   PORTA         ; read parallel input A (clears FA)
        OUT  PORTA         ; write parallel output A
        JMP  LOOP2
```

### Configuring the UART dynamically (Area C = strobe / dynamic mode)

If the board is wired for software config, the word format lives in control-port
bits 4–7. You must include it on **every** control write (the C strobe reloads
CRL each time). Example: 8 data bits, no parity, driving RTS (bit 0) high, and
selecting the "top" baud rate (bit 2):

```asm
; bits 7..4 = UART config (here: WLS1=WLS2=1 → 8 bits, PI=1 → no parity)
; bits 3..0 = control (bit2=1 top baud, bit0=1 RTS)
        MVI  A, 0F5h       ; 1111_0101 — adjust to your Area-H wiring!
        OUT  STATUS        ; write Channel C control word (also fires CRL)
```

The exact bit-to-function mapping depends entirely on the Area H/E/F jumpers, so
this constant is installation-specific. Document the mapping alongside the code.

---

## Emulation Model for 8sim

Implement the 3P+S as a single device claiming **4 consecutive I/O ports**, or as
four cooperating `IIODevice` registrations sharing internal state. Recommended
shape:

### Configuration (constructor options)

```
- baseAddress   : group base (A2–A7), 0x00..0xFC step 4
- channelOrder  : 'ABCD' (parallel-low) | 'CDAB' (serial/control-low, default for PT SW)
- a0Invert      : boolean (swap the UART control/data pair for IMSAI SIO-2 order)
- statusMap     : { TBE:bitmask, RDA:bitmask, OE, FE, PE, FA, FB, XA, XB }
                  default PT-native: TBE=0x80, RDA=0x40 (others 0 / spare bits)
- configMode    : 'static' | 'dynamic'   (Area C: CRL tied high vs. strobed)
- wordFormat    : default {dataBits:8, parity:'none', stopBits:2}
- interrupts    : none (default) | { line, source:['RDA','TBE',...] }
- serialBackend : sink/source for TX/RX bytes (terminal, socket, tape, etc.)
- parallelA/B   : optional attached parallel devices (keyboard, printer, etc.)
```

### Internal state

```
- rhr, rhrFull (RDA)         receive holding register + flag
- thr, tbe                   transmit holding (tbe true when free; instant TX in emu)
- oe, fe, pe                 error flags for current RHR contents
- controlLatch (bits 0–3)    RTS, peripheral driver, baud-select
- uartConfig (bits 4–7)      word format, when configMode='dynamic'
- outLatchA, outLatchB       parallel output latches
- inFlagA (FA), inFlagB (FB) parallel data-available latches
- xdrA, xdrB (XA, XB)        external-device-ready inputs
```

### IN handler (per channel, after applying channelOrder + a0Invert)

- **Channel C (status):** assemble the byte from current flag values through
  `statusMap`. Do **not** clear anything (reading status is non-destructive).
- **Channel D (data):** return `rhr`; clear RDA/OE (DRR pulse). If the backend has
  another byte queued, you may immediately re-arm RDA.
- **Channel A/B (parallel):** return current input byte; **clear FA/FB**.

### OUT handler

- **Channel C (control):** latch bits 0–3 (update RTS / peripheral driver / baud
  select). If `configMode='dynamic'`, reload `uartConfig` from bits 4–7 (this is
  the CRL-on-every-write behavior — recompute word format each time). Emit the
  C strobe to any listener.
- **Channel D (data):** accept byte → push to serial backend; keep TBE true
  (instantaneous transmit) or model a brief busy window if baud timing matters.
  Never block.
- **Channel A/B (parallel):** update output latch; pulse the output strobe to the
  attached parallel device; sample its XDR line into XA/XB.

### Feeding received serial data

When the backend delivers an RX byte: if RDA already set, set **OE** (overrun,
old byte kept or replaced per UART spec — AY-5-1013 keeps the new char and flags
overrun); else load `rhr`, set RDA, and compute FE/PE per the configured format
(FE/PE normally 0 in a clean emulated link). If interrupts are enabled and RDA is
a source, raise the configured line.

### Feeding parallel input data

When an attached device presents a byte on Channel A/B (its "XDAA/XDAB" event):
latch the byte, set FA/FB, assert AKA/AKB to the device. The next `IN A/B` clears
the flag.

### Notes / gotchas to preserve

- **No software master reset** — do not emulate a 2SIO-style `03h` reset register.
  Reset comes from the machine reset line; on reset clear RDA/OE/errors, set TBE.
- **Status word is fully configurable** — hard-coding TBE=bit1/RDA=bit0 (the 2SIO
  layout) will break PT software, and vice-versa. Default to PT-native, expose the
  map.
- **IN vs OUT at the same port are different registers** — mirror the 8080 split.
- **Reading status is non-destructive; reading data clears RDA; reading a parallel
  port clears its FA/FB** — three distinct read side-effects.
- **Dynamic config reloads on every control write** — a subtle corruption source
  that faithful emulation should reproduce (or at least not crash on).

---

## Quick Reference

### Port window (PT serial layout `[C,D,A,B]`, base 0)

| Port | IN | OUT |
|------|----|----|
| base+0 | Status word (flags) | Control word (UART cfg hi nibble, control lo nibble) |
| base+1 | UART RX data (clears RDA) | UART TX data |
| base+2 | Parallel A in (clears FA) | Parallel A out + strobe |
| base+3 | Parallel B in (clears FB) | Parallel B out + strobe |

### Native status bits (Appendix V)

| Bit | Mask | Flag |
|-----|------|------|
| 7 | 0x80 | TBE (transmitter buffer empty / ready) |
| 6 | 0x40 | RDA (receiver data available) |
| others | jumpered | OE / FE / PE / FA / FB / XA / XB |

### Poll idioms

| Check | Code |
|-------|------|
| TX ready? | `IN STATUS` / `ANI 80h` / `JZ wait` (or `RLC`/`JNC`) |
| RX ready? | `IN STATUS` / `ANI 40h` / `JZ wait` |
| Read char | `IN PORT1` (clears RDA) |
| Send char | wait TBE, then `OUT PORT1` |

---

## Sources

- **Processor Technology 3P+S Input/Output Module — Assembly and Operating
  Instructions** (Processor Technology Corp., 1976). Primary source; Sections
  I–V and Appendix V (port test programs) — in this repo at `docs/3P+S Manual.md`.
- Processor Technology *3P+S* — Wikipedia (board history, "3 parallel + serial",
  1976, RS-232-C).
- glitchwrks, *"IMSAI SIO-2 Compatibility with the Processor Tech 3P+S"*
  (users.glitchwrks.com/~glitch/2018/08/30/3ps-imsai-sio) — Area B ordering,
  A0-inversion fix, and an SIO-2-emulation status-bit map.
- s100computers.com — Processor Technology 3P+S board page (general description).
- General-Instrument **AY-5-1013** / AMI **S1883** / TI **TMS6011** UART data
  sheet (TBMT/DAV/DRR, PE/FE/OE, NB1/NB2/NP/EPS/TSB, CRL, 16× clock).
- Processor Technology **SOLOS/CUTER** User's Manual (sol20.org/manuals/solos.pdf)
  — companion monitor software that drives 3P+S-style serial I/O.
</content>
</invoke>
