# SKILL: CDBL — Combo Disk Boot Loader (Altair 88-DCDD 8" / 88-MDS Minidisk)

## Overview

**CDBL (Combo Disk Boot Loader)** is a boot-loader PROM program for the Intel
8080 / MITS Altair 8800 that boots software (e.g. Altair Disk BASIC, CP/M) from
**either** the Altair **88-DCDD 8" floppy** system **or** the Altair **88-MDS
5.25" minidisk** system — automatically detecting which drive type is attached.

- **Version:** 3.00, 16 January 2016
- **Authors:** Martin Eberhard, Mike Douglas
- **Origin:** merges the earlier **DBLe** (8" DBL) and **MDBL** (minidisk) boot
  PROMs into one image, with fixes.
- **Fits in:** one 256-byte 1702A EPROM; execution begins at **FF00h**.

CDBL works exactly like the Altair **DBL** boot PROM (for the 88-DCDD 8"
controller) and the Altair **MDBL** boot PROM (for the 88-MDS minidisk
controller), with the improvements below.

> This loader is the same family as the `88dskrom.bin` used by the 8sim boot
> harnesses. Its annotated source (Appendix B) is the authoritative reference
> for the Altair disk boot-track format, the 2:1 sector interleave, the
> per-sector checksum/marker scheme, and the drive control/status bit meanings
> — see also 88-DCDD.skill.md and MITS-88-2SIO.skill.md.

---

## Improvements over DBL / MDBL

1. **Automatic disk drive type detection.** Before booting, CDBL determines
   whether the drive is 8" or minidisk by looking for the sector that follows
   sector 15: **sector 16 exists ⇒ 8" disk (32 sectors/track); sector wraps to
   0 ⇒ minidisk (16 sectors/track).**
2. **RAM usage.** Like DBL/MDBL, CDBL needs zero-wait-state RAM for fast code, a
   buffer, and the stack. CDBL uses **512 bytes starting at 4600 octal (0x4C00,
   `RAMADR`)**, which limits the loaded program to **19K bytes**.
3. **Position independence.** v3.00+ runs from any PROM socket on a 256-byte
   page boundary (except page 0).
4. **Memory overlay detection.** Aborts with an **`O` error** if the disk data
   would overwrite CDBL's own RAM (at 0x4C00).
5. **Track 0 overshoot correction.** Steps inward once before seeking track 0,
   so booting works even if the track-0 end-stop is maladjusted.
6. **Restart shutoff timer on retries.** The minidisk controller has a 6.4 s
   motor-shutoff timer restarted by each Step / Timer-Reset. CDBL restarts it on
   every sector-read retry, so it can finish booting even from a disk needing
   many retries. (MDBL fails after ~32 retries on one track.)
7. **Correct 88-2SIO initialization** (fixes the DBL bug so error codes print
   correctly on a 2SIO terminal).
8. **88-2SIO reset delay** — waits long enough before resetting the 2SIO that a
   character still in its output buffer (e.g. the `B` from UBMON) finishes
   transmitting.

---

## Installation

- Normally installed at **address 177400 octal (0xFF00)** — slot H on an 88-PMC
  memory card (jumpered to start at 174000 octal), or slot H1 on a Turnkey
  Module.
- v3.00+ will run from any PROM socket, but **UBMON expects it at 174000 octal**
  (0xF400). Manual examples assume 174000 octal — substitute your socket's start
  address if different.

---

## Memory Requirements

- Needs **two 256-byte pages of zero-wait-state RAM starting at 046000 octal
  (0x4C00)**.
- The loaded code is written to RAM **starting at address 0**.
- Practically: the Altair must have **at least 20K of RAM starting at address
  0**, and the **last 4K block of that RAM must be zero-wait-state**. (Dynamic
  RAM is fine; timing has margin for refresh.)
- Because CDBL's RAM page sits at 0x4C00, the **boot file loaded from disk cannot
  exceed 19K bytes** (same limit as MDBL; DBL limits boot files to 11K).

---

## Sense Switch Settings

Loaded software (e.g. Altair Disk BASIC) reads sense switches **`<A15:A12>`** to
select the terminal device. Standard Altair terminal-device settings:

| Terminal Device            | A15 | A14 | A13 | A12 |
|----------------------------|-----|-----|-----|-----|
| 88-2SIO Port 0 (2 stop bits) | 0 | 0 | 0 | 0 |
| 88-2SIO Port 0 (1 stop bit)  | 0 | 0 | 0 | 1 |
| 88-SIO                        | 0 | 0 | 1 | 0 |
| 4PIO                          | 0 | 1 | 0 | 0 |
| PIO                           | 0 | 1 | 0 | 0 |

(Set per the manual for the specific software being loaded.)

---

## Operating Procedure

1. **Access CDBL.** With no monitor: front panel STOP + RESET, then EXAMINE
   address 177400 octal (0xFF00).
2. **Set sense switches** `<A15:A12>` for your terminal device (table above).
3. **Initiate the boot:**
   - Insert the boot disk (minidisk: ensure a write-protect tab is installed).
   - Start CDBL:
     - TURMON: type `J177400` on the terminal.
     - UBMON: type `B` on the terminal.
     - Front panel: press **RUN**.
4. **Booting.** CDBL reads the boot file **one sector at a time**, starting at
   **track 0, sector 0**, writing it into RAM **starting at address 0**. Within
   each track the sectors are read **2:1 interleaved** — even sectors first, then
   odd. Loading continues until the whole boot file is loaded or an irrecoverable
   error occurs. On success, CDBL **jumps to address 0** to execute the loaded
   code. (Many programs load only a small 2-sector loader and then load the rest
   of the software themselves.)

---

## Error Indications

The front panel **Interrupt Enable (INTE)** light stays **off** while loading
proceeds normally. On an irrecoverable error, CDBL:

- turns the **INTE light on**,
- stores the **ASCII error code at memory location 0**,
- stores the **16-bit offending address at locations 1–2**,
- continuously sends the error code to all standard Altair terminal ports until
  you STOP/RESET.

| Code | Name           | Meaning |
|------|----------------|---------|
| `C`  | Checksum error | Computed checksum ≠ disk checksum, or a Marker byte ≠ 377 octal. CDBL retries a bad sector **15 times** before giving up. |
| `M`  | Memory error   | Defective / read-only / protected RAM found when writing to RAM. Offending address at locations 1–2. |
| `O`  | Overlay error  | Attempt to load disk data past the first 19K of memory, which would overlay CDBL's stack/buffer/disk routines. |

---

## Appendix A — Altair Disk Boot-Track Format

Altair disks are **hard-sectored**.

| Format    | Tracks | Sectors/track (numbered) | Bytes/sector | Data bytes/sector |
|-----------|--------|--------------------------|--------------|-------------------|
| 8" (88-DCDD) | 77  | 32 (0–31)                | 137          | 128               |
| Minidisk (88-MDS) | 35 | 16 (0–15)          | 137          | 128               |

- Tracks number sequentially from **track 0** (outside diameter). Loading begins
  at track 0 and continues sequentially until the required byte count (from the
  **File Byte Count** in each sector header) has been read.
- The **first several tracks are reserved for boot code** and usually have a
  slightly different sector format than the rest of the disk.
- **2:1 interleave (at least on the boot tracks):** on each track the **even
  sectors (from 0) load first, then the odd sectors (from 1)**. CDBL needs less
  than one sector-time to process a sector after reading it, so with 2:1
  interleave a whole track reads in just two disk revolutions.

**Boot-track sector layout (137 bytes):**

| Byte(s)  | Field |
|----------|-------|
| 0        | **Track number, with MSB set** (the sync bit) → `0x80 \| track` |
| 1–2      | **File Byte Count** (16-bit, little-endian) |
| 3–130    | **Sector data** (128 bytes) |
| 131      | **Marker byte**, must be **377 octal (0xFF)** |
| 132      | **Checksum** — 8-bit sum of the 128 data bytes |
| 133–136  | Spare (not read by CDBL) |

> This is exactly the "boot framing" seen when probing an Altair CP/M image:
> `b0 = 0x80|track`, `b1 = 0x00`, `stop@131 = 0xFF`, `ck@132 = Σ(data)`. Data
> tracks (typically tracks 6+) use a different "data framing" with a per-sector
> ID byte and skew applied.

---

## Algorithm & Structure (from Appendix B source)

CDBL first copies itself from PROM into RAM at `RAMADR` (0x4C00) with a
position-independent copy loop, then runs from RAM (no `IN`/`OUT` executes until
the code is in RAM — required for some Turnkey Modules). Main phases:

1. **Relocate to RAM.** Copy the 256-byte PROM page to 0x4C00 using a
   position-independent loop (derives its own address via a `CALL`), then `JMP`
   into the RAM image (`RAMIMG`).
2. **Wait for drive ready.** `WAITEN`: enable drive 0 (`OUT DENABL`), poll status
   (`IN DSTAT`) for `DRVRDY` (bit 3, active-low). Load the 8" head / start the
   minidisk 6.4 s timer (`OUT DCTRL, HDLOAD`).
3. **Restore to track 0 (with overshoot fix).** Step **in once**, then step
   **out** repeatedly until `TRACK0` (status bit 6) is detected, waiting for the
   servo (`-MVHEAD`) to settle between steps. Enforces a ≥43 ms delay when
   changing seek direction (8" spec).
4. **Detect 8" vs minidisk.** Watch the sector position register (`IN DSECTR`):
   look for the highest minidisk sector (15). The sector following 15 is **16 on
   an 8" disk** or **0 on a minidisk**; compute **SPT = 16 (minidisk) or 32
   (8")** into register C.
5. **Initialize the console ACIA / PIO** *late* (so an in-flight terminal char
   isn't lost): 88-2SIO/6850 → `OUT ACCTRL, ACRST` (0x03 master reset) then
   `OUT ACCTRL, ACINIT` (0x11 = ÷16, 8-bit, No parity, 2 stop); 4PIO handshake
   setup.
6. **Load loop.** For each track, for each sector in **2:1 interleave order**:
   - **Find sector** (`FNDSEC`): poll `DSECTR` until the wanted sector number is
     under the head and `-SVALID` is low.
   - **Overlay check:** if the DMA target would hit CDBL's RAM page, abort `O`.
   - **Read sector into `SECBUF`** (`DATLUP`): poll `NRDA` (status bit 7,
     active-low) and read each byte from `DDATA` (port 0x0A) — loop must be
     < 32 µs/byte.
   - **Copy + verify + checksum** (`MOVLUP`): copy 128 data bytes from `SECBUF`
     to the final RAM address, **reading each byte back to verify the write**
     (`M` error on mismatch) and summing the checksum.
   - **Marker + checksum check:** marker byte must be `0xFF` and the computed
     checksum must match byte 132, else **retry (up to 16×)**; persistent failure
     ⇒ `C` error (`BADSEC` restarts the minidisk timer on each retry).
   - **Done test:** compare the next DMA address to the **File Byte Count**
     (`SFSIZE`); when reached, exit.
   - **Next sector / next track:** `sector += 2`; after the even pass, start the
     odd pass at sector 1; at end of track, **step in** and continue (no need to
     wait for the step to complete — a full revolution elapses before sector 0).
7. **Terminate.**
   - **Success (`LDDONE`):** disable the disk controller (`OUT DENABL, DDISBL`)
     and `JMP DMAADR` (0) to run the loaded program.
   - **Error (`RPTERR`):** `EI` (INTE light on), store address at 1–2 and code at
     0, then loop forever printing the code to SIO/2SIO/PIO/4PIO ports.

### Key constants / equates

```
BPS    = 128      ; data bytes per sector
MDSPT  = 16       ; minidisk sectors/track  (8" = MDSPT*2 = 32)
HDRSIZ = 3        ; header bytes before data
TLRSIZ = 2        ; trailer bytes read after data
SECSIZ = 137      ; total bytes/sector (BPS+HDRSIZ+TLRSIZ)
RETRYS = 16       ; max retries per sector
RAMADR = 0x4C00   ; RAM image / code destination
SECBUF = RAMADR+512-SECSIZ ; sector buffer
DMAADR = 0x0000   ; disk load & execution address
```

### Disk controller I/O ports (same for 88-DCDD and 88-MDS)

| Port | Read (status/data)                 | Write (control/command) |
|------|------------------------------------|-------------------------|
| 0x08 | `DSTAT` status (active-low)         | `DENABL` drive enable (`0x08`=enable, `0x80`=disable) |
| 0x09 | `DSECTR` sector position           | `DCTRL` drive command |
| 0x0A | `DDATA` read data byte             | `DDATA` write data byte |

**Status (port 0x08, active-low):** `ENWDAT`=0x01, `MVHEAD`=0x02, `HDSTAT`=0x04,
`DRVRDY`=0x08, `INTSTA`=0x20, `TRACK0`=0x40, `NRDA`=0x80.

**Command (port 0x09, write):** `STEPIN`=0x01, `STPOUT`=0x02, `HDLOAD`=0x04
(8": load head / minidisk: restart 6.4 s timer), `HDUNLD`=0x08, `IENABL`=0x10,
`IDSABL`=0x20, `WENABL`=0x80.

**Sector position (port 0x09, read):** `SVALID`=0x01 (low for first ~30 µs of a
sector pulse), `SECMSK`=0x3E (sector-number mask).

### Console I/O equates

```
; 88-SIO
SIOSTA/SIOCTL = 0x00   SIODAT = 0x01
; 88-2SIO port 0 / Turnkey / 88-UIO (Motorola 6850 ACIA)
ACSTAT/ACCTRL = 0x10   ACDATA = 0x11   ACRST = 0x03   ACINIT = 0x11
; 88-PIO
PIOSTA/PIOCTL = 0x04   PIODAT = 0x05
; 88-4PIO port 0
P4CA0=0x20 P4DA0=0x21 P4CB0=0x22 P4DB0=0x23   P4CINI=0x2C
```

Error message bytes: `CERMSG='C'` (0x43), `MERMSG='M'` (0x4D), `OERMSG='O'`
(0x4F).

---

## Appendix B — Annotated Source Listing (CDBL.PRN, ASM/hex)

Assembled with Digital Research's ASM (values in hex). `ORG RAMADR` (0x4C00):
the PROM copies this image to RAM and runs it there.

```asm
        ORG     RAMADR              ; 0x4C00 — assemble at dest RAM address
4C00 F3          di                 ; turn off INTE (no error yet)

; --- Position-independent copy of the PROM page into RAM ---
4C01 110E4C      lxi     d,MLOOP    ; DE -> MLOOP in RAM
4C04 317B4D      lxi     sp,STACK
4C07 21E1E9      lxi     h,0E9E1h    ; H=PCHL, L=POP H
4C0A E5          push    h           ; POP H, PCHL at STACK-2, STACK-1
4C0B CD794D      call    STACK-2     ; addr of MLOOP in HL and stack RAM
4C0E 3B  MLOOP:  dcx     sp          ; point SP to MLOOP address
4C0F 3B          dcx     sp          ;   in stack memory
4C10 7E          mov     a,m         ; get next EPROM byte
4C11 12          stax    d           ; store it in RAM
4C12 1C          inr     e           ; bump pointers
4C13 2C          inr     l
4C14 C0          rnz                 ; copy to end of 256-byte page
4C15 C3184C      jmp     RAMIMG      ; jump to code now in RAM  (e=l=0)

; ===== RAM Code Image (runs at RAMADR) =====
RAMIMG:
; Wait for a diskette in drive 0, then load that drive's head.
4C18 AF  WAITEN: xra     a           ; boot from disk 0
4C19 D308        out     DENABL      ; enable disk 0
4C1B DB08        in      DSTAT       ; read drive status
4C1D E608        ani     DRVRDY      ; diskette in drive?
4C1F C2184C      jnz     WAITEN      ; no: wait for drive ready
4C22 3E04        mvi     a,HDLOAD    ; load 8" head, or enable
4C24 D309        out     DCTRL       ;  minidisk for 6.4 Sec

; Step in once, then step out until track 0 is detected.  (Exit b=0)
4C26 018206      lxi     b,20000/12  ; 20 mS delay 1st time thru
4C29 3E01        mvi     a,STEPIN    ; step in once first
4C2B D309 SKTRK0:out     DCTRL       ; issue step command
4C2D 0B  DELAY:  dcx     b           ; force >=43 ms on 1st dir change
4C2E 78          mov     a,b
4C2F B1          ora     c
4C30 C22D4C      jnz     DELAY
4C33 0C          inr     c           ; from now on the loop goes 1 time
4C34 DB08 WSTEP: in      DSTAT       ; wait for step to complete
4C36 0F          rrc                 ; MVHEAD bit into carry
4C37 0F          rrc                 ; is the servo stable?
4C38 DA344C      jc      WSTEP       ; no: wait for servo to settle
4C3B E610        ani     TRACK0/4    ; are we at track 00?
4C3D 3E02        mvi     a,STPOUT    ; STEP-OUT command
4C3F C22B4C      jnz     SKTRK0      ; no: step out another track  (b=0)

; Determine 8" vs minidisk; set C = sectors/track.
4C42 DB09 CKDSK1:in      DSECTR      ; read sector position
4C44 E63F        ani     SECMSK+SVALID
4C46 FE1E        cpi     (MDSPT-1)*2 ; minidisk last sector
4C48 C2424C      jnz     CKDSK1      ; only while SVALID is 0
4C4B DB09 CKDSK2:in      DSECTR
4C4D 0F          rrc                 ; wait for invalid sector
4C4E D24B4C      jnc     CKDSK2
4C51 DB09 CKDSK3:in      DSECTR
4C53 0F          rrc
4C54 DA514C      jc      CKDSK3      ; wait for sector to be valid
4C57 E61F        ani     SECMSK/2    ; mask sector bits
4C59 C610        adi     MDSPT       ; compute SPT (10h or 20h)
4C5B 4F          mov     c,a         ; save SPT in c

; Initialize the ACIA (2SIO port 0 / Turnkey / UIO) — done late.
4C5C 3E03        mvi     a,ACRST     ; reset first
4C5E D310        out     ACCTRL
4C60 3E11        mvi     a,ACINIT    ; then initialize (/16, 8N2)
4C62 D310        out     ACCTRL
; Initialize the 4PIO
4C64 AF          xra     a
4C65 D322        out     P4CB0       ; Port 0 section B is output
4C67 2F          cma                 ; all output bits high
4C68 D323        out     P4DB0
4C6A 3E2C        mvi     a,P4CINI    ; set up handshake bits
4C6C D322        out     P4CB0

; Set up to load: b=0 (init sector), c=SPT, l=0 (part of DMA address)
4C6E 65          mov     h,l         ; initial DMA address = 0000
4C6F 3E10 NXTSEC:mvi     a,RETRYS    ; init sector retries
4C71 317B4D RDSECT:lxi   sp,STACK    ; (re)init the stack
4C74 F5          push    psw         ; remaining retry count
; Sector Read step 1: hunt for sector b.
4C75 DB09 FNDSEC:in      DSECTR      ; read the sector position
4C77 E63F        ani     SECMSK+SVALID
4C79 0F          rrc                 ; sector bits to <4:0>
4C7A B8          cmp     b           ; found desired sector w/ -SVALID low?
4C7B C2754C      jnz     FNDSEC      ; no: wait for it
; Overlay check.
4C7E 117B4D      lxi     d,SECBUF    ; sector buffer address
4C81 7C          mov     a,h         ; high byte of DMA address
4C82 AA          xra     d           ; high byte of RAM code addr
4C83 E6FE        ani     0FEh        ; ignore lsb
4C85 3E4F        mvi     a,OERMSG    ; overlay error message
4C87 CAE14C      jz      RPTERR      ; report overlay error
; Set up upcoming data move.
4C8A E5          push    h           ; current DMA address
4C8B C5          push    b           ; current sector & SPT
4C8C 018000      lxi     b,BPS       ; b=init checksum, c=byte count for MOVLUP
; Sector Read step 2: read sector data into SECBUF at de.  (<32 µs/pass)
4C8F DB08 DATLUP:in      DSTAT       ; read the drive status
4C91 07          rlc                 ; new read data available?
4C92 DA8F4C      jc      DATLUP      ; no: wait for data
4C95 DB0A        in      DDATA       ; read data byte
4C97 12          stax    d           ; store it in sector buffer
4C98 1C          inr     e           ; next buffer address / test for end
4C99 C28F4C      jnz     DATLUP      ; loop if more data
; Sector Read step 3: move data from SECBUF to memory at hl; compute checksum.
4C9C 1E7E        mvi     e,SDATA and 0FFh ; de = address of sector data
4C9E 1A  MOVLUP: ldax    d           ; get sector buffer byte
4C9F 77          mov     m,a         ; store it at the destination
4CA0 BE          cmp     m           ; did it store correctly?
4CA1 C2DF4C      jnz     MEMERR      ; no: abort w/ memory error
4CA4 80          add     b           ; update checksum
4CA5 47          mov     b,a         ; save the updated checksum
4CA6 13          inx     d           ; bump sector buffer pointer
4CA7 23          inx     h           ; bump DMA pointer
4CA8 0D          dcr     c           ; more data bytes to copy?
4CA9 C29E4C      jnz     MOVLUP      ; yes: loop
; Sector Read step 4: check marker byte and compare checksum.
4CAC EB          xchg                ; hl=1st trailer byte addr, de=DMA addr
4CAD 4E          mov     c,m         ; get marker, should be FFh
4CAE 0C          inr     c           ;  c should be 0 now
4CAF 23          inx     h           ; (hl)=checksum byte
4CB0 AE          xra     m           ; compare to computed checksum
4CB1 B1          ora     c           ; and test marker=ff
4CB2 C1          pop     b           ; current sector & SPT
4CB3 C2D24C      jnz     BADSEC      ; NZ: checksum error
; Compare next DMA address to the file byte count; done if DMA >= size.
4CB6 2A7C4D      lhld    SFSIZE      ; hl gets file size
4CB9 EB          xchg                ; DMA addr in hl, file size in de
4CBA 7D          mov     a,l         ; 16-bit subtraction
4CBB 93          sub     e
4CBC 7C          mov     a,h
4CBD 9A          sbb     d           ; keep carry (borrow)
4CBE D2E34C      jnc     LDDONE      ; done loading if hl >= de
; Next sector (2:1 interleave: even sectors, then odd).  NXTSEC repairs stack.
4CC1 116F4C      lxi     d,NXTSEC    ; for compact jumps
4CC4 D5          push    d
4CC5 04          inr     b           ; sector = sector + 2
4CC6 04          inr     b
4CC7 78          mov     a,b         ; even or odd sectors done?
4CC8 B9          cmp     c           ; c = SPT
4CC9 D8          rc                  ; no: go read next sector at NXTSEC
4CCA 0601        mvi     b,01H       ; 1st odd sector number
4CCC C8          rz                  ; Z: must read odd sectors now at NXTSEC
; Next track: step in, and read again.  (NXTRAC repairs the stack)
4CCD 78          mov     a,b         ; STEPIN happens to be 01h
4CCE D309        out     DCTRL
4CD0 05          dcr     b           ; start with b=0 for sector 0
4CD1 C9          ret                 ; go to NXTSEC

; *** Checksum error: retry if not too many, else abort 'C' ***
; Top of stack = address of first byte of failing sector; next = retry count
4CD2 3E04 BADSEC:mvi     a,HDLOAD    ; restart minidisk 6.4 s timer
4CD4 D309        out     DCTRL
4CD6 E1          pop     h           ; restore DMA address
4CD7 F1          pop     psw         ; get retry count
4CD8 3D          dcr     a           ; any more retries left?
4CD9 C2714C      jnz     RDSECT      ; yes: try reading it again
4CDC 3E43        mvi     a,CERMSG    ; checksum error message
4CDE 11          db      11H         ; 'lxi d' opcode → skip MEMERR, go RPTERR

; *** Memory error: memory write-verify failed.  hl = offending RAM addr ***
4CDF 3E4D MEMERR:mvi     a,MERMSG    ; memory error message  (falls into RPTERR)

; *** CDBL termination ***
; RPTERR: a=error code, hl=offending addr. LDDONE: normal exit (carry clear).
4CE1 47  RPTERR: mov     b,a         ; error code
4CE2 37          stc                 ; remember we had an error
4CE3 3E80 LDDONE:mvi     a,DDISBL    ; disable the disk controller
4CE5 D308        out     DENABL
4CE7 D20000      jnc     DMAADR      ; normal exit: execute loaded program
4CEA FB          ei                  ; signal error on the INTE LED
4CEB 220100      shld    1           ; store the bad address
4CEE 78          mov     a,b         ; recover the error code
4CEF 320000      sta     0           ; store the error code
4CF2 D301 ERHANG:out     SIODAT      ; SIO
4CF4 D311        out     ACDATA      ; 2SIO port 0 / Turnkey / UIO
4CF6 D305        out     PIODAT      ; PIO
4CF8 D323        out     P4DB0       ; 4PIO
4CFA C3F24C      jmp     ERHANG      ; keep printing error code
4CFD             end
```

---

## Notes for the 8sim emulator

- The 8sim `MitsDcddCard` implements the port 0x08/0x09/0x0A behavior this loader
  drives: active-low status, `NRDA` gating, sector-position register with
  `SVALID`, and the 2:1-interleave read pattern. See 88-DCDD.skill.md.
- **Head-load persistence:** CDBL (and the multi-stage loaders it chains to)
  assume the head-load state survives a drive deselect/reselect — the emulated
  card must not drop head-load on `OUT DENABL,0x80`.
- **Boot vs data framing:** the 137-byte layout above is *boot* framing (byte 1
  = 0, marker@131=0xFF, checksum@132). Directory/data tracks use *data* framing
  with a per-sector ID byte and skew — a mismatch here (reserved-track count vs
  the boot/data boundary) is a classic cause of a post-banner "Bad Sector".
- **Seek timing:** CDBL times steps against real drive specs (≥43 ms on
  direction change). An emulator that decouples CPU time from wall-clock should
  treat seeks as instantaneous and must never *drop* step pulses (that desyncs
  track position).

---

## References

- *CDBL — Combo Disk Boot Loader User's Guide*, Version 3.00, Martin Eberhard &
  Mike Douglas, 16 January 2016 (`docs/CDBL Manual.pdf`).
- Altair 88-DCDD 8" Floppy Disk System manual (MITS).
- Altair 88-MDS Minidisk System manual (MITS).
- Related skills: 88-DCDD.skill.md, MITS-88-2SIO.skill.md, MITS.Bootloader.skill.md.
