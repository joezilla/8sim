/**
 * IMSAI FIF boot harness — boots IMDOS / CP/M to an interactive prompt.
 *
 * Builds an IMSAI 8080 with the IMSAI MPU-A monitor/boot ROM at 0xD800 (RAM
 * elsewhere), an IMSAI SIO-2 console (channel A at 0x02/0x03, board control
 * 0x08), and the DMA-capable FIF floppy controller on output port 0xFD. Running
 * from the ROM's power-on entry (0xD800), the monitor checks drive 0, loads its
 * boot sector, and starts the OS — which drives the FIF via `OUT 0xFD` to load
 * the rest of itself. (This mirrors how the MITS boot needs the CDBL PROM.)
 *
 * Disk backend (env-selected):
 *   - default: an in-process image (FIF_DISK=/path, default the bundled
 *     tests/fixtures/imdos202.dsk). Loaded with Node fs (examples/ may use it).
 *   - FDCPLUS_URL set: the fdcplus-web WebSocket backend (3328-byte tracks),
 *     with the image mounted on the server as drive 0.
 *
 *   npm run boot:fif
 *
 * Type at the A> prompt (try DIR); Ctrl-] quits.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Cpu8080 } from '../src/cpu/Cpu8080.js';
import { InterruptController } from '../src/interrupt/InterruptController.js';
import { Ram } from '../src/memory/Ram.js';
import { Rom } from '../src/memory/Rom.js';
import { Bus } from '../src/bus/Bus.js';
import { ImsaiSioCard } from '../src/cards/ImsaiSioCard.js';
import { ImsaiFifCard } from '../src/cards/ImsaiFifCard.js';
import { InMemoryFloppyDisk, type FloppyDisk } from '../src/cards/floppy/FloppyDisk.js';
import { FdcPlusClient, type WebSocketLike } from '../src/cards/FdcPlusClient.js';
import { FdcPlusFloppyDisk } from '../src/cards/floppy/FdcPlusFloppyDisk.js';
import { MachineRunner, type CpuSpeed } from '../src/machine/MachineRunner.js';

const ROM_PATH = join(process.cwd(), 'bios/imsai-mpu-a-rom.bin');
const ROM_BASE = 0xd800; // IMSAI MPU-A monitor/boot ROM location + power-on jump
const DISK_PATH = process.env.FIF_DISK ?? join(process.cwd(), 'tests/fixtures/imdos202.dsk');
const FDCPLUS_URL = process.env.FDCPLUS_URL;
const KEY = process.env.FDCPLUS_TOKEN ?? '';
const CLIENT_ID = process.env.FDCPLUS_CLIENT_ID;

function parseSpeed(s: string): CpuSpeed {
  const v = s.trim().toLowerCase();
  if (v === 'max' || v === 'full') return 'max';
  const mhz = v.match(/^(\d+(?:\.\d+)?)\s*mhz$/);
  if (mhz) return Math.round(parseFloat(mhz[1]!) * 1_000_000);
  const hz = Number(v);
  if (Number.isFinite(hz) && hz > 0) return hz;
  return 2_000_000;
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

async function makeDisk(): Promise<{ disk: FloppyDisk; close: () => void; label: string }> {
  if (FDCPLUS_URL) {
    const wsurl = `${FDCPLUS_URL.replace(/^http/, 'ws')}/fdc-ws?token=${KEY}` +
      (CLIENT_ID ? `&clientId=${encodeURIComponent(CLIENT_ID)}` : '');
    const raw = new WebSocket(wsurl);
    await new Promise<void>((resolve, reject) => {
      raw.addEventListener('open', () => resolve(), { once: true });
      raw.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
      setTimeout(() => reject(new Error('WebSocket open timeout')), 5000);
    });
    await sleep(200);
    const client = new FdcPlusClient(new NodeWsAdapter(raw));
    return { disk: new FdcPlusFloppyDisk(client, 0, 'std-sd'), close: () => raw.close(), label: `fdcplus-web ${FDCPLUS_URL}` };
  }
  if (!existsSync(DISK_PATH)) {
    console.error(`No disk image at ${DISK_PATH}. Set FIF_DISK=/path/to/image.dsk (256256 bytes) or FDCPLUS_URL for the network backend.`);
    process.exit(1);
  }
  const bytes = new Uint8Array(readFileSync(DISK_PATH));
  return { disk: new InMemoryFloppyDisk('std-sd', bytes), close: () => {}, label: DISK_PATH };
}

async function main(): Promise<void> {
  if (!existsSync(ROM_PATH)) {
    console.error(`IMSAI MPU-A boot ROM not found at ${ROM_PATH}`);
    process.exit(1);
  }
  const rom = new Uint8Array(readFileSync(ROM_PATH));
  const { disk, close, label } = await makeDisk();

  const pic = new InterruptController();
  const bus = new Bus(pic);
  // RAM everywhere except the monitor ROM window; the FIF is I/O-only.
  bus.attachMemory(new Ram('lo', 0x0000, ROM_BASE));
  bus.attachMemory(new Rom('mpu-a', ROM_BASE, rom));
  bus.attachMemory(new Ram('hi', ROM_BASE + rom.length, 0x10000 - (ROM_BASE + rom.length)));

  const sio = new ImsaiSioCard('sio', { basePortA: 0x02, basePortB: 0x04, boardCtrlPort: 0x08 });
  sio.attach(bus);
  const fif = new ImsaiFifCard('fif', { disks: { '0': disk } });
  fif.attach(bus);

  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.pc = ROM_BASE; // power-on jump into the monitor; it auto-boots drive 0

  sio.channelA.onTransmit((byte) => process.stdout.write(String.fromCharCode(byte & 0x7f)));
  const stdin = process.stdin;
  const restore = () => { if (stdin.isTTY) stdin.setRawMode(false); };
  const shutdown = (msg: string) => {
    restore();
    try { close(); } catch { /* ignore */ }
    process.stdout.write(`\r\n${msg}\r\n`);
    process.exit(0);
  };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', (buf: Buffer) => {
    for (const byte of buf) {
      if (byte === 0x1d) { shutdown('[emulator halted]'); return; } // Ctrl-]
      sio.channelA.enqueueRx(byte);
    }
  });
  process.on('SIGINT', () => shutdown('[emulator halted]'));

  const speedLabel = SPEED === 'max' ? 'max speed' : `${(SPEED / 1_000_000).toFixed(SPEED % 1_000_000 ? 3 : 0)} MHz`;
  process.stdout.write(`Booting IMSAI (MPU-A ROM + FIF) from ${label} at ${speedLabel}...  (Ctrl-] to quit)\r\n`);

  const runner = new MachineRunner(cpu, {
    hz: SPEED,
    schedule: (fn, ms) => { if (ms > 0) setTimeout(fn, ms); else setImmediate(fn); },
    onError: (e) => shutdown(`[cpu error: ${String(e)}]`),
  });
  runner.start();
}

main().catch((e) => { console.error(e); process.exit(1); });
