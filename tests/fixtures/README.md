# Test fixtures

Binary ROM/COM images used by the integration tests. Most are **not** committed
(they are third-party binaries); tests that need them skip gracefully when absent.

## Committed

- `88dskrom.bin` — Altair 88-DSK boot PROM image (256 bytes).

## Z80 exercisers (fetch on demand)

Public-domain CP/M diagnostics used by `tests/integration/z80-*.test.ts`. Download them with:

```bash
npm run fixtures:z80
```

This fetches into this directory:

| File          | Purpose                                              | Runtime          |
|---------------|------------------------------------------------------|------------------|
| `prelim.com`  | Preliminary Z80 sanity check (~1 s).                 | always-on test   |
| `zexdoc.com`  | Documented-flags instruction exerciser.              | gated (minutes)  |
| `zexall.com`  | All-flags (incl. undocumented) instruction exerciser.| gated (minutes)  |

Source: <https://github.com/anotherlin/z80emu> (`testfiles/`).
Mirror: <http://mdfs.net/Software/Z80/Exerciser/>.

`zexdoc`/`zexall` are long-running; they only execute when `Z80_ZEX=1` is set:

```bash
Z80_ZEX=1 npx vitest run tests/integration/z80-zex.test.ts
```

## 8080 diagnostic (optional)

- `cpudiag.com` — Microcosm CP/M 8080 diagnostic used by `tests/integration/cpudiag.test.ts`.
  Place it here manually to enable that test.
