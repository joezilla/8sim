#!/bin/sh
# Assemble the SOLOS "BOOTLOAD" personality (SOLOS monitor + a BOOT command that
# bootstraps the Helios II disk system) into bootload.bin — a 2 KB ROM @ 0xC000.
# Same toolchain + DW->DB fix as build-cuter.sh (see that script for the why).
#
# Requires z80asm (Udo Munk's Z80/8080 assembler, ships with z80pack). Set Z80ASM.
#
#   ./build-bootload.sh
#
# Notes:
#   - The Helios BOOT routine is at 0xC367; it drives controller ports F0-F7,
#     reads 832 bytes from drive-0 track 0 into 0x0000, and `RST 0`s to it.
#   - SOLOS forces its console to the Sol-20 VDM display (STRTA sets OPORT/IPORT=0)
#     and uses the Sol serial port at 0xF8/0xF9 (NOT the 3P+S at 0/1) — so the
#     Helios controller test drives the BOOT routine directly rather than via an
#     interactive serial prompt.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
Z80ASM="${Z80ASM:-z80asm}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
perl -pe "s/\\bDW(\\s+'..')/DB\$1/" "$here/bootload.asm" > "$tmp/bootload.asm"
"$Z80ASM" -8 -fb "-o$tmp/bootload.full" "$tmp/bootload.asm"
dd if="$tmp/bootload.full" of="$here/bootload.bin" bs=1 count=2048 2>/dev/null
echo "wrote $here/bootload.bin ($(wc -c < "$here/bootload.bin" | tr -d ' ') bytes); BOOT entry @0xC367"
