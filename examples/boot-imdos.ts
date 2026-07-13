/**
 * IMSAI MDC-DIO boot harness.
 *
 * Builds an IMSAI 8080 + 56K RAM (0x0000-0xDFFF) + an IMSAI SIO-2 console
 * (channel A at 0x02/0x03, board control 0x08) + the firmware-driven MDC-DIO
 * floppy controller occupying the memory window 0xE000-0xEFFF, then performs the
 * front-panel "EXAMINE E000, RUN" bootstrap: the stub firmware reads track 0 /
 * sector 1 of drive 0 into 0x0000-0x007F and JMPs to 0x0000.
 *
 * Disk backend (pick with env):
 *   - default: an in-process image (MDCDIO_DISK=/path, default the bundled
 *     tests/fixtures/imdos202.dsk). Loaded with Node fs (examples/ may use it).
 *   - FDCPLUS_URL set: the fdcplus-web WebSocket backend (same transport the
 *     MITS 88-DCDD card uses), reading/writing 3328-byte (26×128) tracks. The
 *     image must be mounted on the server as drive 0.
 *
 *   npm run boot:imdos
 *
 * ── Caveat about the bundled z80pack images ─────────────────────────────────
 * The z80pack IMSAI disks (imdos202.dsk, cpm22.dsk, ...) are standard IBM-3740
 * format (77×26×128), so the MDC-DIO reads/writes their sectors correctly — but
 * their on-disk BIOS drives the IMSAI *FIF* controller (I/O port 0xFD), not the
 * MDC-DIO firmware API (CALL E006/E00C). So the boot sector loads and jumps, but
 * the OS itself will not come up on this card. A genuine MDC-DIO system disk
 * (whose loader/BIOS use the firmware CALLs) is required for a full boot; this
 * harness is ready for one. What you can watch here is the bootstrap DMA and any
 * console output the first-stage loader emits before it reaches for the FIF.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Cpu8080 } from '../src/cpu/Cpu8080.js';
import { InterruptController } from '../src/interrupt/InterruptController.js';
import { Ram } from '../src/memory/Ram.js';
import { Bus } from '../src/bus/Bus.js';
import { ImsaiSioCard } from '../src/cards/ImsaiSioCard.js';
import { ImsaiMdcDioCard } from '../src/cards/ImsaiMdcDioCard.js';
import { InMemoryMdcDioDisk, type MdcDioDisk } from '../src/cards/mdcdio/MdcDioDisk.js';
import { FdcPlusClient, type WebSocketLike } from '../src/cards/FdcPlusClient.js';
import { FdcPlusMdcDioDisk } from '../src/cards/mdcdio/FdcPlusMdcDioDisk.js';
import { MachineRunner, type CpuSpeed } from '../src/machine/MachineRunner.js';

const DISK_PATH = process.env.MDCDIO_DISK ?? join(process.cwd(), 'tests/fixtures/imdos202.dsk');
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

async function makeDisk(): Promise<{ disk: MdcDioDisk; close: () => void; label: string }> {
  if (FDCPLUS_URL) {
    const wsurl = `${FDCPLUS_URL.replace(/^http/, 'ws')}/fdc-ws?token=${KEY}` +
      (CLIENT_ID ? `&clientId=${encodeURIComponent(CLIENT_ID)}` : '');
    const raw = new WebSocket(wsurl);
    await new Promise<void>((resolve, reject) => {
      raw.addEventListener('open', () => resolve(), { once: true });
      raw.addEventListener('error', () => reject(new Error('WebSocket error')), { once: true });
      setTimeout(() => reject(new Error('WebSocket open timeout')), 5000);
    });
    await sleep(200); // let the server start our served loop
    const client = new FdcPlusClient(new NodeWsAdapter(raw));
    return { disk: new FdcPlusMdcDioDisk(client, 0, 'std-sd'), close: () => raw.close(), label: `fdcplus-web ${FDCPLUS_URL}` };
  }
  if (!existsSync(DISK_PATH)) {
    console.error(`No disk image at ${DISK_PATH}. Set MDCDIO_DISK=/path/to/image.dsk (77×26×128 = 256256 bytes) or FDCPLUS_URL for the network backend.`);
    process.exit(1);
  }
  const bytes = new Uint8Array(readFileSync(DISK_PATH));
  return { disk: new InMemoryMdcDioDisk('std-sd', bytes), close: () => {}, label: DISK_PATH };
}

async function main(): Promise<void> {
  const { disk, close, label } = await makeDisk();

  const pic = new InterruptController();
  const bus = new Bus(pic);
  bus.attachMemory(new Ram('ram', 0x0000, 0xe000)); // 0x0000-0xDFFF, clear of the E000 window

  const sio = new ImsaiSioCard('sio', { basePortA: 0x02, basePortB: 0x04, boardCtrlPort: 0x08 });
  sio.attach(bus);

  const mdc = new ImsaiMdcDioCard('mdc', { disks: { 'std:0': disk } });
  mdc.attach(bus);

  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.sp = 0xdf00;
  cpu.registers.pc = 0xe000; // EXAMINE E000 + RUN (standard-drive bootstrap)

  // Wire the SIO-2 console to this terminal.
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
  process.stdout.write(`Booting IMSAI MDC-DIO from ${label} at ${speedLabel}...  (Ctrl-] to quit)\r\n`);

  const runner = new MachineRunner(cpu, {
    hz: SPEED,
    schedule: (fn, ms) => { if (ms > 0) setTimeout(fn, ms); else setImmediate(fn); },
    onError: (e) => shutdown(`[cpu error: ${String(e)}]`),
  });
  runner.start();
}

main().catch((e) => { console.error(e); process.exit(1); });
