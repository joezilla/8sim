#!/bin/sh
# Reproducibly assemble the Processor Technology CUTER monitor (2 KB ROM @ 0xC000)
# from the archived source cuter.asm into cuter.bin — the ROM 8sim boots on the
# virtual 3P+S serial card (examples/boot-cuter.ts).
#
# Requires Udo Munk's z80asm (Z80/8080 macro assembler), which ships with z80pack:
#   https://github.com/udo-munk/z80pack  (z80pack/z80asm/z80asm)
# Point Z80ASM at it, or have `z80asm` on PATH.
#
#   ./build-cuter.sh
#
# The one non-obvious step is the DW->DB patch: CUTER's command tables hold each
# 2-character command name as `DW 'DU'`. The original Processor Technology / Intel
# assembler stored that char pair in order (bytes 'D','U'), which is what CUTER's
# matcher (FDCOM) compares byte-by-byte. z80asm instead evaluates 'DU' as the
# number 'D'*256+'U' and stores it little-endian (bytes 'U','D') — reversed — so
# no command would ever match and the monitor answers every command with '?'.
# Rewriting those command-name entries as `DB` emits the bytes in order and fixes
# the match without altering table layout (still 2 bytes per name).
set -e
here="$(cd "$(dirname "$0")" && pwd)"
Z80ASM="${Z80ASM:-z80asm}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# DW '<2 chars>'  ->  DB '<2 chars>'  (command-name table entries only)
perl -pe "s/\\bDW(\\s+'..')/DB\$1/" "$here/cuter.asm" > "$tmp/cuter.asm"

# -8 = Intel 8080 mnemonics, -fb = raw binary output.
"$Z80ASM" -8 -fb "-o$tmp/cuter.full" "$tmp/cuter.asm"

# Keep the 2 KB ROM (0xC000-0xC7FF); the tail is RAM DS reservations.
dd if="$tmp/cuter.full" of="$here/cuter.bin" bs=1 count=2048 2>/dev/null
echo "wrote $here/cuter.bin ($(wc -c < "$here/cuter.bin" | tr -d ' ') bytes)"
