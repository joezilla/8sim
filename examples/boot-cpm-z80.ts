/**
 * Interactive CP/M boot harness — Zilog Z80 edition.
 *
 * Identical to examples/boot-cpm.ts but drives a Z80 core instead of the 8080.
 * Boots the same machine as tests/integration/bootdisk.live.test.ts — 63.75K RAM
 * + 88-DSK boot PROM + Intel 8251 console (0x12/0x13) + MITS 88-DCDD floppy
 * controller backed by a live fdcplus-web server over WebSocket — but bridges the
 * 8251 console to this process's stdin/stdout so you get a real interactive CP/M
 * session. Type at the A> prompt; Ctrl-] quits the emulator.
 *
 * The Z80 is 8080-binary-compatible, so stock Altair CP/M boots unchanged.
 *
 * Requires a running fdcplus-web server with a bootable disk mounted on
 * drive 0. The server URL and API token are read from FDCPLUS_URL and
 * FDCPLUS_TOKEN (loaded from a .env file — see .env.example and README).
 * The CPU runs at an authentic 2 MHz by default; set CPU_HZ=4mhz or
 * CPU_HZ=max (or a raw Hz number) to change it.
 *
 *   npm run boot:cpm:z80
 *
 * Note: disk writes (PIP, ED, SAVE, ...) are flushed back to the mounted image
 * on the server — this is a read/write session against the real disk file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CpuZ80 } from '../src/cpu/z80/CpuZ80.js';
import { InterruptController } from '../src/interrupt/InterruptController.js';
import { Ram } from '../src/memory/Ram.js';
import { Rom } from '../src/memory/Rom.js';
import { Bus } from '../src/bus/Bus.js';
import { ImsaiSioCard } from '../src/cards/ImsaiSioCard.js';
import { MitsDcddCard } from '../src/cards/MitsDcddCard.js';
import { MachineRunner, type CpuSpeed } from '../src/machine/MachineRunner.js';
import type { WebSocketLike } from '../src/cards/FdcPlusClient.js';

// Server location and API token come from the environment (see .env.example).
const KEY = process.env.FDCPLUS_TOKEN;
const BASE = process.env.FDCPLUS_URL ?? 'http://localhost:3000';
if (!KEY) {
  console.error('FDCPLUS_TOKEN is not set. Copy .env.example to .env and fill in your fdcplus-web API token.');
  process.exit(1);
}
// fdcplus-web sessions are copy-on-write: disk writes land in a per-client
// "splinter", not the master image. Anonymous splinters vanish with the
// connection — set FDCPLUS_CLIENT_ID to a stable name so yours persists
// across sessions (commit it to the master via the server's
// /api/drives/:id/transient/commit endpoint when desired).
const CLIENT_ID = process.env.FDCPLUS_CLIENT_ID;
const WSURL = `${BASE.replace(/^http/, 'ws')}/fdc-ws?token=${KEY}` +
  (CLIENT_ID ? `&clientId=${encodeURIComponent(CLIENT_ID)}` : '');
const AUTH = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// CPU speed: "2mhz" (default, stock 8080), "4mhz", "max", or a raw Hz number.
function parseSpeed(s: string): CpuSpeed {
  const v = s.trim().toLowerCase();
  if (v === 'max' || v === 'full') return 'max';
  const mhz = v.match(/^(\d+(?:\.\d+)?)\s*mhz$/);
  if (mhz) return Math.round(parseFloat(mhz[1]!) * 1_000_000);
  const hz = Number(v);
  if (Number.isFinite(hz) && hz > 0) return hz;
  console.error(`Unrecognized CPU_HZ "${s}" — use e.g. 2mhz, 4mhz, 2000000, or max.`);
  process.exit(1);
}
const SPEED = parseSpeed(process.env.CPU_HZ ?? '2mhz');

/** Adapt Node's built-in WebSocket to the card's WebSocketLike interface. */
class NodeWsAdapter implements WebSocketLike {
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((err: unknown) => void) | null = null;

  constructor(private readonly raw: WebSocket) {
    raw.binaryType = 'arraybuffer';
    raw.addEventListener('message', (ev: MessageEvent) => this.onmessage?.({ data: ev.data }));
    raw.addEventListener('close', () => this.onclose?.());
    raw.addEventListener('error', (e) => this.onerror?.(e));
  }
  get readyState(): number { return this.raw.readyState; }
  send(data: Uint8Array): void { this.raw.send(data); }
  close(): void { this.raw.close(); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // --- Boot ROM ------------------------------------------------------------
  // CDBL (Combo Disk Boot Loader) v3.00 — assembled from bios/cdbl-bootloader.asm.
  // Position-independent: the 0x4C00-assembled page runs correctly at 0xFF00.
  const romPath = join(process.cwd(), 'bios/cdbl-bootloader.bin');
  if (!existsSync(romPath)) {
    console.error(`boot ROM not found at ${romPath}`);
    process.exit(1);
  }
  const romBytes = new Uint8Array(readFileSync(romPath));

  // --- Reachability check --------------------------------------------------
  try {
    const r = await fetch(`${BASE}/api/drives`, { headers: AUTH, signal: AbortSignal.timeout(2000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch {
    console.error(`fdcplus-web not reachable at ${BASE} — start the server and mount a disk on drive 0.`);
    process.exit(1);
  }

  // --- Connect the WebSocket & bind it as the FDC transport ----------------
  const raw = new WebSocket(WSURL);
  await new Promise<void>((resolve, reject) => {
    raw.addEventListener('open', () => resolve(), { once: true });
    raw.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
    setTimeout(() => reject(new Error('WebSocket open timeout')), 5000);
  });
  // Opening the /fdc-ws socket IS the bind: under multi-client serving the
  // server spins up a dedicated copy-on-write served loop for this connection
  // (ConnectionManager.addWsClient). Do NOT poke /api/disk-serving here — a
  // disable→enable "rebind" ritual tears down this very connection (disable
  // runs connectionManager.stopAll) and re-binds serving to the configured
  // serial port, orphaning us mid-boot. Just give the server a beat to start
  // our served loop before the CPU issues its first FDC command.
  await sleep(200);

  // --- Build the machine ---------------------------------------------------
  const pic = new InterruptController();
  const bus = new Bus(pic);
  bus.attachMemory(new Ram('ram', 0x0000, 0xff00)); // 0x0000-0xFEFF
  bus.attachMemory(new Rom('bootrom', 0xff00, romBytes));

  // 8251 console at data 0x12 / status+ctrl 0x13 (board ctrl off 0x08).
  const sio = new ImsaiSioCard('sio', { basePortA: 0x12, boardCtrlPort: 0x18 });
  sio.attach(bus);

  // 88-DCDD floppy controller over the live WebSocket server.
  const dcdd = new MitsDcddCard('dcdd', new NodeWsAdapter(raw));
  dcdd.attach(bus);

  const cpu = new CpuZ80(bus, pic);
  cpu.reset();
  cpu.pc = 0xff00;

  // --- Wire the 8251 console to this terminal ------------------------------
  // TX (CP/M -> screen)
  sio.channelA.onTransmit((byte) => process.stdout.write(String.fromCharCode(byte & 0x7f)));

  const stdin = process.stdin;
  const restore = () => { if (stdin.isTTY) stdin.setRawMode(false); };
  const shutdown = (msg: string) => {
    restore();
    try { raw.close(); } catch { /* ignore */ }
    process.stdout.write(`\r\n${msg}\r\n`);
    process.exit(0);
  };

  if (stdin.isTTY) stdin.setRawMode(true); // char-at-a-time, no local echo
  stdin.resume();
  // RX (keyboard -> CP/M)
  stdin.on('data', (buf: Buffer) => {
    for (const byte of buf) {
      if (byte === 0x1d) { shutdown('[emulator halted]'); return; } // Ctrl-]
      sio.channelA.enqueueRx(byte);
    }
  });
  process.on('SIGINT', () => shutdown('[emulator halted]'));

  const speedLabel = SPEED === 'max' ? 'max speed' : `${(SPEED / 1_000_000).toFixed(SPEED % 1_000_000 ? 3 : 0)} MHz`;
  process.stdout.write(`Booting CP/M (Z80) from fdcplus-web at ${speedLabel}...  (Ctrl-] to quit)\r\n`);

  // --- Run at the configured speed, yielding so WS I/O + timers advance ----
  const runner = new MachineRunner(cpu, {
    hz: SPEED,
    // setImmediate yields faster than setTimeout(0) for 'max' throughput.
    schedule: (fn, ms) => { if (ms > 0) setTimeout(fn, ms); else setImmediate(fn); },
    onError: (e) => shutdown(`[cpu error: ${String(e)}]`),
  });
  runner.start();
}

main().catch((e) => { console.error(e); process.exit(1); });
