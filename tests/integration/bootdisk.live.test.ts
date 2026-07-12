import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Rom } from '../../src/memory/Rom.js';
import { Bus } from '../../src/bus/Bus.js';
import { SnoopBus } from '../../src/bus/SnoopBus.js';
import type { IBusObserver } from '../../src/interfaces/IBusObserver.js';
import { ImsaiSioCard } from '../../src/cards/ImsaiSioCard.js';
import { MitsDcddCard } from '../../src/cards/MitsDcddCard.js';
import type { WebSocketLike } from '../../src/cards/FdcPlusClient.js';

/**
 * LIVE boot: 8080 + 63.75K RAM + 88-DSK boot PROM + 8251 console, with the
 * MITS 88-DCDD floppy controller backed by a real fdcplus-web server over its
 * WebSocket transport. Boots CP/M 2.2 from the mounted LIFEBOAT IMSAI image and
 * captures the sign-on banner off the console.
 *
 * Memory: RAM 0x0000-0xFEFF, boot PROM 0xFF00-0xFFFF. The 62K CP/M loads into
 * high RAM (~0xD800-0xF9xx), so a smaller RAM cannot hold it.
 *
 * Console: this disk's BIOS drives an Intel 8251 at data 0x12 / status+ctrl
 * 0x13 (NOT the IMSAI SIO's 0x02/0x03), so channel A of the SIO card is placed
 * there. Observed init is the canonical 8251 sequence 40/CE/37.
 *
 * Requires the fdcplus-web server running on :3000 with drive 0 mounted and
 * multi-client serving enabled (opening /fdc-ws starts a per-client served loop
 * via ConnectionManager.addWsClient). Skips if the server is unreachable.
 *
 * Run:  npx vitest run tests/integration/bootdisk.live.test.ts
 */
// Server location and API token come from the environment (see .env.example).
// The test skips when the token is unset or the server is unreachable.
const KEY = process.env.FDCPLUS_TOKEN ?? '';
const BASE = process.env.FDCPLUS_URL ?? 'http://localhost:3000';
const WSURL = `${BASE.replace(/^http/, 'ws')}/fdc-ws?token=${KEY}`;
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

async function serverReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/drives`, { headers: AUTH, signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

describe('LIVE 88-DSK boot over fdcplus-web WebSocket', () => {
  it('boots CP/M from the mounted disk image', async () => {
    if (!KEY) {
      console.warn('FDCPLUS_TOKEN not set — skipping live boot test (see .env.example)');
      return;
    }
    if (!(await serverReachable())) {
      console.warn(`fdcplus-web not reachable at ${BASE} — skipping live boot test`);
      return;
    }

    // --- Boot ROM ------------------------------------------------------------
    const romPath = join(import.meta.dirname ?? '', '../fixtures/88dskrom.bin');
    const romBytes = new Uint8Array(readFileSync(romPath));
    expect(romBytes.length).toBe(256);

    // --- Connect the WebSocket & bind it as the FDC transport ----------------
    const raw = new WebSocket(WSURL);
    await new Promise<void>((resolve, reject) => {
      raw.addEventListener('open', () => resolve(), { once: true });
      raw.addEventListener('error', (e) => reject(new Error(`WS error: ${String(e)}`)), { once: true });
      setTimeout(() => reject(new Error('WS open timeout')), 5000);
    });
    // Opening the /fdc-ws socket IS the bind: under multi-client serving the
    // server spins up a dedicated copy-on-write served loop for this connection
    // (ConnectionManager.addWsClient). Do NOT poke /api/disk-serving here — a
    // disable→enable "rebind" ritual tears down the shared disk-serving server
    // and, because enableDiskServing prefers a connected WS client over the
    // serial port, rebinds serving onto THIS ephemeral socket. Closing the
    // socket at teardown then leaves "Serve over serial" switched off on the
    // server. Just give the server a beat to start our served loop before the
    // CPU issues its first FDC command.
    await sleep(200);

    // --- Build the machine ---------------------------------------------------
    // The LIFEBOAT image is a 62K CP/M that loads into high memory (~0xD800..
    // 0xF9xx) and jumps to a BIOS around 0xEF00/0xF395, so RAM must fill the
    // whole space up to the boot ROM at 0xFF00.
    const RAM_SIZE = 0xff00; // 0x0000-0xFEFF (63.75 KB)
    const pic = new InterruptController();
    const realBus = new Bus(pic);
    const ram = new Ram('ram', 0x0000, RAM_SIZE);
    const rom = new Rom('bootrom', 0xff00, romBytes);
    realBus.attachMemory(ram);
    realBus.attachMemory(rom);

    // This disk's CP/M BIOS drives the console as an 8251 at data 0x12 /
    // status+ctrl 0x13, so put channel A there. Board-control port off 0x08.
    const sio = new ImsaiSioCard('sio', { basePortA: 0x12, boardCtrlPort: 0x18 });
    sio.attach(realBus);
    let serialOut = '';
    const onTx = (byte: number) => {
      const ch = byte & 0x7f; // strip parity/mark bit for display
      serialOut += String.fromCharCode(ch);
      process.stdout.write(String.fromCharCode(ch));
    };
    sio.channelA.onTransmit(onTx);
    sio.channelB.onTransmit(onTx);

    // MITS 88-DCDD at 0x08-0x0A, backed by the live WS server.
    const dcdd = new MitsDcddCard('dcdd', new NodeWsAdapter(raw));
    dcdd.attach(realBus);

    // --- Snoop for diagnostics ----------------------------------------------
    const ioReads = new Map<number, number>();
    const ioWrites = new Map<number, number>();
    const initWrites: string[] = [];
    const snoop: IBusObserver = {
      onIoRead: (p) => ioReads.set(p, (ioReads.get(p) ?? 0) + 1),
      onIoWrite: (p, v) => {
        ioWrites.set(p, (ioWrites.get(p) ?? 0) + 1);
        if (p === 0x13 && initWrites.length < 12) {
          initWrites.push(`OUT 13,${v.toString(16).padStart(2, '0')}`);
        }
      },
    };
    const bus = new SnoopBus(realBus);
    bus.attach(snoop);

    const cpu = new Cpu8080(bus, pic);
    cpu.reset();
    cpu.registers.pc = 0xff00;

    // --- Run, yielding to the event loop so WS I/O + timers can advance ------
    const BATCH = 40_000;
    const DEADLINE = Date.now() + 45_000;
    let steps = 0;
    let lastLen = 0;
    let quietYields = 0;

    while (Date.now() < DEADLINE) {
      for (let i = 0; i < BATCH; i++) {
        cpu.step();
        steps++;
      }
      await new Promise((r) => setImmediate(r)); // deliver WS frames, fire timers

      if (serialOut.length > lastLen) {
        lastLen = serialOut.length;
        quietYields = 0;
      } else {
        quietYields++;
      }
      // Stop once CP/M has printed its banner and gone quiet at the prompt.
      if (serialOut.length > 0 && quietYields > 40) break;
    }

    // --- Report --------------------------------------------------------------
    const hex = (n: number, w = 4) => n.toString(16).toUpperCase().padStart(w, '0');
    const fmt = (m: Map<number, number>) =>
      [...m.entries()].sort((a, b) => a[0] - b[0]).map(([p, c]) => `0x${hex(p, 2)}×${c}`).join(', ');
    console.log('\n===== LIVE 88-DSK boot =====');
    console.log(`steps      : ${steps}`);
    console.log(`final PC   : 0x${hex(cpu.registers.pc)}`);
    console.log(`I/O writes : ${fmt(ioWrites) || 'none'}`);
    console.log(`I/O reads  : ${fmt(ioReads) || 'none'}`);
    console.log(`8251 init  : ${initWrites.join(' ') || 'none'}`);
    console.log(`serial out : ${JSON.stringify(serialOut)}`);
    console.log('============================\n');

    // Closing the socket ends this client's served loop; it does NOT touch the
    // server's shared serial disk-serving state (see the connect-block note).
    raw.close();

    // --- Assertions ----------------------------------------------------------
    // The DCDD was driven (drive select + head load) and the disk was read.
    expect(ioWrites.has(0x08)).toBe(true);
    expect(ioWrites.has(0x09)).toBe(true);
    expect(ioReads.get(0x0a) ?? 0).toBeGreaterThan(137); // read at least one sector
    // CP/M booted and printed its sign-on banner to the console.
    expect(serialOut).toContain('CP/M');
  }, 60_000);
});
