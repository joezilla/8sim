#!/bin/sh
# Assemble the Processor Technology SOLOS personality module (the SOL-20 stand-
# alone operating system) into solos.bin — a 2 KB ROM @ 0xC000.
#
# Source is solos1.asm: Jim Battle's V1.3 source "tweaked to match the existing
# binary found in a personality module of a particular machine" (see its header)
# — so it assembles to the genuine SOLOS 1.3 ROM byte-for-byte. Same toolchain +
# DW->DB command-table fix as build-cuter.sh / build-bootload.sh (see those for
# the why: z80asm stores DW '<2 chars>' little-endian, reversing the byte pair
# that SOLOS's command matcher compares in order).
#
# Requires z80asm (Udo Munk's Z80/8080 assembler, ships with z80pack). Set Z80ASM.
#
#   ./build-solos.sh
#
# SOLOS drives the Sol-20 built-in console: VDM-1 display memory @0xCC00, the Sol
# keyboard (data 0xFC, ready = bit 0 of status 0xFA), and the Sol serial port at
# 0xF8/0xF9. On cold start STRTA sets OPORT/IPORT=0 (device 0 = the VDM/keyboard).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
Z80ASM="${Z80ASM:-z80asm}"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
perl -pe "s/\\bDW(\\s+'..')/DB\$1/" "$here/solos1.asm" > "$tmp/solos.asm"
"$Z80ASM" -8 -fb "-o$tmp/solos.full" "$tmp/solos.asm"
dd if="$tmp/solos.full" of="$here/solos.bin" bs=1 count=2048 2>/dev/null
echo "wrote $here/solos.bin ($(wc -c < "$here/solos.bin" | tr -d ' ') bytes)"
