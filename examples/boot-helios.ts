/**
 * Processor Technology Helios II boot demo.
 *
 * Runs the genuine SOLOS **BOOTLOAD** ROM's `BOOT` routine (@0xC367), which
 * drives the Helios controller (ports F0-F7): it restores unit 0, loads the
 * head, waits for index/ready, DMAs 832 bytes of track 0 into 0x0000, and
 * `RST 0`s to it. Here the synthetic track-0 "boot sector" is a small program
 * that prints a banner over a serial port and halts — proving the faithful
 * Helios controller satisfies the real boot code end-to-end.
 *
 *   npm run boot:helios
 *
 * Disk backend: in-memory synthetic (default), or an SVH image via HELIOS_DISK,
 * or fdcplus-web via FDCPLUS_URL (raw Helios tracks, 16×324 bytes/track).
 *
 * Note: the real PTDOS system disk (drive 0) isn't publicly available; the
 * bundled bios/sol20/helios/b1d1-proteus.svh is a real *data* disk (drive 1),
 * good for reading but not booting. So this demo boots a synthetic payload.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Cpu8080 } from '../src/cpu/Cpu8080.js';
import { InterruptController } from '../src/interrupt/InterruptController.js';
import { Ram } from '../src/memory/Ram.js';
import { Rom } from '../src/memory/Rom.js';
import { Bus } from '../src/bus/Bus.js';
import { HeliosCard } from '../src/cards/HeliosCard.js';
import { InMemoryHeliosDisk, type HeliosDisk } from '../src/cards/helios/HeliosDisk.js';
import { ProcTech3pSCard } from '../src/cards/ProcTech3pSCard.js';
import { FdcPlusClient, type WebSocketLike } from '../src/cards/FdcPlusClient.js';
import { FdcPlusHeliosDisk } from '../src/cards/helios/FdcPlusHeliosDisk.js';

const ROM_PATH = join(process.cwd(), 'bios/sol20/bootload.bin');
const BOOT_ENTRY = 0xc367;

// Track-0 boot payload: print "HELIOS BOOT OK" to the serial port (status 0xF8,
// data 0xF9, PT-native TBE=bit7), then HLT.
function bootPayload(): Uint8Array {
  const prog = [
    0x21, 0x20, 0x00, //       LXI H, msg (0x0020)
    0x7e, //             loop: MOV A,M
    0xb7, //                   ORA A
    0xca, 0x17, 0x00, //       JZ done
    0x47, //                   MOV B,A
    0xdb, 0xf8, //       tbe:  IN 0xF8 (serial status)
    0xe6, 0x80, //             ANI 0x80 (TBE)
    0xca, 0x09, 0x00, //       JZ tbe
    0x78, //                   MOV A,B
    0xd3, 0xf9, //             OUT 0xF9 (serial data)
    0x23, //                   INX H
    0xc3, 0x03, 0x00, //       JMP loop
    0x76, //             done: HLT
  ];
  const payload = new Uint8Array(832);
  payload.set(prog, 0);
  payload.set([...'\r\nHELIOS BOOT OK\r\n'].map((c) => c.charCodeAt(0)), 0x20);
  return payload;
}

async function makeDisk(): Promise<{ disk: HeliosDisk; close: () => void; label: string }> {
  const url = process.env.FDCPLUS_URL;
  if (url) {
    const wsurl = `${url.replace(/^http/, 'ws')}/fdc-ws?token=${process.env.FDCPLUS_TOKEN ?? ''}`;
    const raw = new WebSocket(wsurl);
    await new Promise<void>((res, rej) => {
      raw.addEventListener('open', () => res(), { once: true });
      raw.addEventListener('error', () => rej(new Error('WebSocket error')), { once: true });
      setTimeout(() => rej(new Error('WebSocket open timeout')), 5000);
    });
    await new Promise((r) => setTimeout(r, 200));
    (raw as WebSocket).binaryType = 'arraybuffer';
    const adapter: WebSocketLike = {
      onmessage: null, onclose: null, onerror: null,
      get readyState() { return raw.readyState; },
      send: (d) => raw.send(d), close: () => raw.close(),
    };
    raw.addEventListener('message', (ev: MessageEvent) => adapter.onmessage?.({ data: ev.data }));
    return { disk: new FdcPlusHeliosDisk(new FdcPlusClient(adapter), 0), close: () => raw.close(), label: `fdcplus-web ${url}` };
  }
  const path = process.env.HELIOS_DISK;
  if (path && existsSync(path)) {
    return { disk: InMemoryHeliosDisk.fromSvh(new Uint8Array(readFileSync(path))), close: () => {}, label: path };
  }
  const disk = new InMemoryHeliosDisk();
  await disk.writeData(0, 0, bootPayload());
  return { disk, close: () => {}, label: 'synthetic (banner payload)' };
}

async function main(): Promise<void> {
  if (!existsSync(ROM_PATH)) {
    console.error(`BOOTLOAD ROM not found at ${ROM_PATH} — run bios/sol20/build-bootload.sh`);
    process.exit(1);
  }
  const rom = new Uint8Array(readFileSync(ROM_PATH)).slice(0, 0x800);
  const { disk, close, label } = await makeDisk();

  const pic = new InterruptController();
  const bus = new Bus(pic);
  bus.attachMemory(new Ram('lo', 0x0000, 0xc000));
  bus.attachMemory(new Rom('bootload', 0xc000, rom));
  bus.attachMemory(new Ram('hi', 0xc800, 0x10000 - 0xc800));

  // SOLOS serial port at 0xF8/0xF9 (distinct from Helios F0-F7); wire to stdout.
  const sio = new ProcTech3pSCard('sio', { baseAddress: 0xf8 });
  sio.attach(bus);
  sio.serial.onTransmit((b) => process.stdout.write(String.fromCharCode(b & 0x7f)));

  const helios = new HeliosCard('helios', { port: 0xf0, disks: { '0': disk } });
  helios.attach(bus);

  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.sp = 0xbf00;
  cpu.registers.pc = BOOT_ENTRY;

  process.stdout.write(`Booting Helios II (BOOTLOAD BOOT) from ${label}...\r\n`);
  const flush = (): Promise<void> => new Promise((r) => setImmediate(r));
  for (let b = 0; b < 400 && !cpu.halted; b++) {
    for (let i = 0; i < 50_000 && !cpu.halted; i++) cpu.step();
    await flush();
  }
  close();
  process.stdout.write(cpu.halted ? '\r\n[boot payload halted]\r\n' : '\r\n[stopped]\r\n');
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
