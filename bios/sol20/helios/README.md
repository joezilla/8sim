# Helios II — disk format + reference artifacts

Reference material for the 8sim Processor Technology **Helios II** disk controller
(`src/cards/HeliosCard.ts`). Sources: the Helios manual (`docs/Helios Manual.md`), the SOLOS
`BOOTLOAD` boot code (`bios/sol20/bootload.asm`), and Jim Battle's HELIOS.EXE tool + design notes
(`sol20.org/utility/helios.zip`).

## Artifacts in this dir

- `b1d1-proteus.svh` — a **real PTDOS Helios disk image** (label "proteus 1"), recovered by
  converting Battle's `b1d1.raw` Catweasel flux capture with the tool below. Data blocks decoded
  intact (real PTDOS files are visible, e.g. `OPTIREAD`); the block *headers* on this particular
  capture decoded as zeros (a flux-recovery limitation of this dump, not the format). Good for
  validating the controller's data-read path (M3). **Not** the bootable system disk (that would be
  drive 0 / `b1d0`, which we don't have — so a real PTDOS *boot* still needs a system-disk image).
- `helios-tool` — the HELIOS.EXE converter, **built for macOS** (`src/` + a small POSIX shim: DOS
  `<io.h>`/`_O_*` mapped to POSIX, backslash includes fixed, Catweasel *hardware*-capture symbols
  stubbed since only the file-conversion path is used). Usage: `helios-tool <in.raw|in.svh> -v out.svh`
  converts flux/`.svh`; `helios-tool <in.svh>` lists the PTDOS directory. Rebuild: see `src/` +
  compile with `cc -std=gnu89 -w -Ishim -include shim/io.h src/*.c shim/cwstub.c` (excluding
  `catweasl.c`/`cwpci.c`).
- `src/` — the tool's C source (authoritative format reference: `vdisk_svh_lib.[ch]`, `vdisk_svd.h`,
  `helios_ptdos.c`).

The 13.5 MB `b1d1.raw` flux capture and the `helios.zip`/`ptsrc.zip` archives are **not** committed
(size); re-fetch from `sol20.org/utility/helios.zip` and `sol20.org/ptsrc/ptsrc.zip` if needed.

## Disk geometry

- **77 tracks** (0–76), **16 logical sectors/track** (uses 16 of the 32 hard-sector holes), single
  sided, single density, 360 RPM. ~384 KB/disk.

## Firm-sectored block model

Data is stored in **variable-size blocks (1–4095 bytes)** spanning **1–13 sectors** (not fixed 256B).
Constraints: a block stays on one track and cannot cross the sector-15→0 boundary. Files are a
**doubly-linked list of blocks** via the header's next/prev pointers.

Each block on the physical disk: `15×00 preamble · sync · 13-byte header · 2-byte CRC · sync ·
15×00 preamble · sync · NNN data · 2-byte CRC · sync · postamble`. **The emulator models none of the
preamble/sync/CRC** (invisible to the host; controller-generated) — only the header + data bytes.

### 13-byte block header (controller reads/writes this; CRC is controller-generated)

| byte | field |
|---|---|
| 0 | this sector |
| 1 | this track |
| 2 | next sector | (0xFF,0xFF next = last block of file) |
| 3 | next track |
| 4 | prev sector | (0xFF,0xFF prev = first block of file) |
| 5 | prev track |
| 6–7 | file ID (16-bit LE, unique per file per disk) |
| 8 | block length in sectors |
| 9–10 | block length in bytes (LE); **bit 15 = last block of file** |
| 11–12 | reserved |

A freshly formatted sector has an all-`0xFF` header and a single `0xFF` data byte.

## SVD/SVH file format (the emulator's image format — "Solace Virtual Disk, Helios")

Portable, fixed layout — the format the in-memory + fdcplus backends use.

- **First 4096 bytes = header**: `char format[64]` = `"SVD:Solace Virtual Disk, Helios"` (NUL-padded),
  then LE `uint16` fields at offset 64: `version(=1) writeprot density(=1) sides(=1) tracks(=77)
  sectors(=16)`, pad to 1024, then `char label[3072]` (CR/LF lines, NUL-terminated) at offset 1024.
- **Then `tracks*sectors` = 1232 blocks**, each **324 bytes**: a **4-byte overhead**
  `[fmt, dataLen_lo, dataLen_hi, 0x00]` followed by a **320-byte payload**.
  - `fmt` flags: `0x01` HAS_HEADER, `0x02` HAS_DATA, `0x04` FIRST_DATA (first sector of a block),
    `0x08` LAST_DATA (last sector), `0x10` CRC-error-header, `0x20` CRC-error-data.
  - Within the 320-byte payload: **header** (13 bytes) at **offset 16** when `HAS_HEADER`; **data**
    (dataLen bytes) at **offset 48** when a header is present, else at **offset 0**.
- Block file offset: `4096 + (track*16 + sector) * 324`.
- Total = `4096 + 77*16*324` = **403,264 bytes**.

## Host boot contract (from bootload.asm)

I/O ports **F0–F7**. Boot: `OUT F7,0CF` (unit 0, restore) → `OUT F5` (clear status) → `OUT F1,FF`
(cancel) → poll F0 b6 (seek complete) → `OUT F7,0DF` (load head 0) → poll F0 b7 (index) → poll F0 b1
(ready) → `OUT F5/F6=0000` (DMA addr) → `OUT F3/F4=0340` (832 bytes) → `OUT F1,03` (READ DATA) → poll
F0 (CRC-checked/TC) → `RST 0`. i.e. read the first 832 data bytes of track 0 → 0x0000, jump.
