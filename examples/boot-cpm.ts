/**
 * Interactive CP/M boot harness.
 *
 * Boots the same machine as tests/integration/bootdisk.live.test.ts — 8080 +
 * 63.75K RAM + 88-DSK boot PROM + Intel 8251 console (0x12/0x13) + MITS 88-DCDD
 * floppy controller backed by a live fdcplus-web server over WebSocket — but
 * bridges the 8251 console to this process's stdin/stdout so you get a real
 * interactive CP/M session. Type at the A> prompt; Ctrl-] quits the emulator.
 *
 * Requires a running fdcplus-web server with a bootable disk mounted on
 * drive 0. The server URL and API token are read from FDCPLUS_URL and
 * FDCPLUS_TOKEN (loaded from a .env file — see .env.example and README).
 *
 *   npm run boot:cpm
 *
 * Note: disk writes (PIP, ED, SAVE, ...) are flushed back to the mounted image
 * on the server — this is a read/write session against the real disk file.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Cpu8080 } from '../src/cpu/Cpu8080.js';
import { InterruptController } from '../src/interrupt/InterruptController.js';
import { Ram } from '../src/memory/Ram.js';
import { Rom } from '../src/memory/Rom.js';
import { Bus } from '../src/bus/Bus.js';
import { ImsaiSioCard } from '../src/cards/ImsaiSioCard.js';
import { MitsDcddCard } from '../src/cards/MitsDcddCard.js';
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
  await fetch(`${BASE}/api/disk-serving/disable`, { method: 'POST', headers: AUTH });
  await fetch(`${BASE}/api/disk-serving/enable`, { method: 'POST', headers: AUTH });
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

  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.pc = 0xff00;

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

  process.stdout.write('Booting CP/M from fdcplus-web...  (Ctrl-] to quit)\r\n');

  // --- Run, yielding to the event loop so WS I/O + timers advance ----------
  const BATCH = 40_000;
  const loop = () => {
    try {
      for (let i = 0; i < BATCH; i++) cpu.step();
    } catch (e) {
      shutdown(`[cpu error: ${String(e)}]`);
      return;
    }
    setImmediate(loop);
  };
  loop();
}

main().catch((e) => { console.error(e); process.exit(1); });
