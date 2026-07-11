import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildMachine } from '../../src/machine/buildMachine.js';
import type { CardFactory } from '../../src/machine/MachineSpec.js';
import { ImsaiSioCard } from '../../src/cards/ImsaiSioCard.js';
import { MitsDcddCard } from '../../src/cards/MitsDcddCard.js';
import type { WebSocketLike } from '../../src/cards/FdcPlusClient.js';

/**
 * Golden test (Story 1.1 AC-3): the CDBL 8080 skeleton boots to its first FDC
 * command purely from a MachineSpec — no hand-wired machine.
 *
 * Machine mirrors examples/boot-cpm.ts: 8080 + 63.75K RAM + CDBL boot PROM at
 * 0xFF00 + IMSAI 8251 console + MITS 88-DCDD floppy controller. The DCDD is
 * backed by a fake FDC channel that captures the first frame the machine sends
 * — the "first FDC command" — without a live server. The CDBL loader selects a
 * drive / loads the head early, which fires a STAT/READ over the channel.
 */
describe('CDBL boots from a MachineSpec', () => {
  it('reaches its first FDC command built purely from a spec', async () => {
    const romPath = join(import.meta.dirname ?? '', '../../bios/cdbl-bootloader.bin');
    if (!existsSync(romPath)) {
      console.warn(`CDBL boot ROM not found at ${romPath}; skipping.`);
      return;
    }
    const rom = new Uint8Array(readFileSync(romPath));

    // Fake FDC channel: capture what the machine sends; never reply (we only
    // need to prove the machine reaches its first command).
    const sent: Uint8Array[] = [];
    const fakeWs: WebSocketLike = {
      send(data: Uint8Array) {
        sent.push(data instanceof Uint8Array ? data : new Uint8Array(data));
      },
      close() {},
      onmessage: null,
      onclose: null,
      onerror: null,
      readyState: 1,
    };

    const sioFactory: CardFactory = (id) =>
      new ImsaiSioCard(id, { basePortA: 0x12, boardCtrlPort: 0x18 });
    const dcddFactory: CardFactory = (id) => new MitsDcddCard(id, fakeWs);

    const machine = buildMachine({
      cpuKind: 'i8080',
      clock: 'max',
      resetVector: 0xff00,
      memory: [
        { id: 'ram', base: 0x0000, size: 0xff00, kind: 'ram' },
        { id: 'cdbl', base: 0xff00, size: rom.length, kind: 'rom', image: rom },
      ],
      cards: [
        // ImsaiSioCard(basePortA:0x12, boardCtrlPort:0x18) registers channelA
        // (0x12/0x13), channelB at its 0x04 default (0x04/0x05), and ctrl 0x18.
        { id: 'sio', factory: sioFactory, claims: { ports: [0x12, 0x13, 0x04, 0x05, 0x18] } },
        { id: 'dcdd', factory: dcddFactory, claims: { ports: [0x08, 0x09, 0x0a] } },
      ],
    });

    expect(machine.cpu.pc).toBe(0xff00);

    // Step, flushing microtasks so the DCDD's async STAT/READ actually sends.
    const flush = () => new Promise((r) => setTimeout(r, 0));
    let steps = 0;
    const MAX_STEPS = 5_000_000;
    while (steps < MAX_STEPS && sent.length === 0 && !machine.cpu.halted) {
      for (let i = 0; i < 5000 && !machine.cpu.halted; i++) {
        machine.cpu.step();
        steps++;
      }
      await flush();
    }

    const decodeCmd = (f: Uint8Array): string =>
      f.length >= 4 ? String.fromCharCode(f[0]!, f[1]!, f[2]!, f[3]!) : '?';

    // The machine, assembled from a spec alone, executed CDBL and issued its
    // first FDC command over the channel.
    expect(sent.length).toBeGreaterThan(0);
    expect(['STAT', 'READ', 'WRIT']).toContain(decodeCmd(sent[0]!));
  });
});
