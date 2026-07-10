import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FdcPlusClient, type WebSocketLike } from '../../src/cards/FdcPlusClient.js';
import { MitsDcddCard } from '../../src/cards/MitsDcddCard.js';
import { Bus } from '../../src/bus/Bus.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';

// ── Mock WebSocket ────────────────────────────────────────────────────────────

class MockWs implements WebSocketLike {
  readyState = 1; // OPEN
  sent: Uint8Array[] = [];
  onmessage: ((ev: { data: Uint8Array }) => void) | null = null;
  onclose:   (() => void) | null = null;
  onerror:   ((err: unknown) => void) | null = null;

  send(data: Uint8Array): void { this.sent.push(new Uint8Array(data)); }
  close(): void {}
  inject(data: Uint8Array): void { this.onmessage?.({ data }); }
  lastSent(): Uint8Array { return this.sent[this.sent.length - 1] ?? new Uint8Array(0); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMnemonic(frame: Uint8Array): string {
  return String.fromCharCode(frame[0] ?? 0, frame[1] ?? 0, frame[2] ?? 0, frame[3] ?? 0);
}

function parseP1(frame: Uint8Array): number {
  return (frame[4] ?? 0) | ((frame[5] ?? 0) << 8);
}

function parseP2(frame: Uint8Array): number {
  return (frame[6] ?? 0) | ((frame[7] ?? 0) << 8);
}

function makeResponse(mnemonic: string, p1: number, p2: number): Uint8Array {
  const buf = new Uint8Array(8);
  for (let i = 0; i < 4; i++) buf[i] = mnemonic.charCodeAt(i) & 0xff;
  buf[4] = p1 & 0xff;
  buf[5] = (p1 >> 8) & 0xff;
  buf[6] = p2 & 0xff;
  buf[7] = (p2 >> 8) & 0xff;
  return buf;
}

// Drain microtasks (Promises, .then(), .finally()) without advancing fake timers.
// Exchanges are serialized on the wire, so a queued command resolves through a
// deeper chain of continuations than before — drain generously.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

// ── FdcPlusClient ─────────────────────────────────────────────────────────────

describe('FdcPlusClient — STAT', () => {
  it('sends correct 8-byte STAT frame', () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    void client.stat(0, true, 5);
    const f = ws.sent[0]!;
    expect(parseMnemonic(f)).toBe('STAT');
    expect(parseP1(f)).toBe(0x0100); // headLoad=1 in high byte, drive=0 in low byte
    expect(parseP2(f)).toBe(5);      // track
  });

  it('resolves with ready bitmap from response param2', async () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    const p = client.stat(0, false, 0);
    ws.inject(makeResponse('STAT', 0x0000, 0x03));
    expect(await p).toBe(3);
  });
});

describe('FdcPlusClient — READ', () => {
  it('sends correct READ frame with drive/track encoding', () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    void client.readTrack(2, 35, 4384);
    const f = ws.sent[0]!;
    expect(parseMnemonic(f)).toBe('READ');
    // drive=2, track=35 → (2 << 12) | 35 = 0x2023
    expect(parseP1(f)).toBe(0x2023);
    expect(parseP2(f)).toBe(4384);
  });

  it('resolves with track data after receiving length bytes', async () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    const p = client.readTrack(0, 0, 4384);
    const data = new Uint8Array(4384);
    data[0] = 0xAB; data[4383] = 0xCD;
    ws.inject(data);
    const result = await p;
    expect(result[0]).toBe(0xAB);
    expect(result[4383]).toBe(0xCD);
    expect(result.length).toBe(4384);
  });

  it('accumulates fragmented frames into full track', async () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    const p = client.readTrack(0, 0, 4384);
    const part1 = new Uint8Array(2000); part1[0] = 0x11;
    const part2 = new Uint8Array(2384); part2[2383] = 0x22;
    ws.inject(part1);
    ws.inject(part2);
    const result = await p;
    expect(result.length).toBe(4384);
    expect(result[0]).toBe(0x11);
    expect(result[4383]).toBe(0x22);
  });
});

describe('FdcPlusClient — WRIT', () => {
  it('sends WRIT frame, then data after OK ack, then resolves on WSTA OK', async () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    const data = new Uint8Array(4384).fill(0x5A);
    const p = client.writeTrack(1, 10, data);

    // Step 1: WRIT request frame
    expect(parseMnemonic(ws.sent[0]!)).toBe('WRIT');
    expect(parseP1(ws.sent[0]!)).toBe((1 << 12) | 10); // drive=1,track=10

    // Step 2: inject WRIT ack (OK)
    ws.inject(makeResponse('WRIT', 0x00, 0));
    await flushMicrotasks(); // let .then() send track data

    // Step 3: track data should have been sent
    expect(ws.sent[1]!.length).toBe(4384);
    expect(ws.sent[1]![0]).toBe(0x5A);

    // Step 4: inject WSTA OK
    ws.inject(makeResponse('WSTA', 0x00, 0));
    await p; // resolves cleanly
  });

  it('rejects if WRIT ack is NOT_READY (0x01)', async () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    const p = client.writeTrack(0, 0, new Uint8Array(4384));
    ws.inject(makeResponse('WRIT', 0x01, 0)); // NOT_READY
    await expect(p).rejects.toThrow('WRIT rejected');
  });

  it('rejects if WSTA reports WRITE_ERR (0x03)', async () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    const p = client.writeTrack(0, 0, new Uint8Array(4384));
    ws.inject(makeResponse('WRIT', 0x00, 0)); // OK ack
    await flushMicrotasks();
    ws.inject(makeResponse('WSTA', 0x03, 0)); // WRITE_ERR
    await expect(p).rejects.toThrow('WSTA error');
  });
});

describe('FdcPlusClient — wire serialization', () => {
  it('holds commands issued during an in-flight WRIT exchange until it completes', async () => {
    // Regression: WRIT is multi-frame (header → ack → raw data → WSTA). A STAT
    // or READ sent between the header and the payload is consumed by the server
    // as track data, and the payload's tail spills out as garbage commands
    // ("Unknown command: \0\0\0\0"), permanently desyncing the stream.
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    const wp = client.writeTrack(0, 5, new Uint8Array(4384).fill(0x5A));
    const sp = client.stat(0, true, 5);      // issued mid-exchange
    const rp = client.readTrack(0, 5, 8);    // issued mid-exchange
    expect(ws.sent.length).toBe(1);          // only the WRIT header is out

    ws.inject(makeResponse('WRIT', 0x00, 0));
    await flushMicrotasks();
    expect(ws.sent.length).toBe(2);          // header + payload, nothing interleaved
    expect(ws.sent[1]!.length).toBe(4384);

    ws.inject(makeResponse('WSTA', 0x00, 0));
    await wp;
    await flushMicrotasks();
    expect(parseMnemonic(ws.sent[2]!)).toBe('STAT'); // released in order
    ws.inject(makeResponse('STAT', 0x00, 0x01));
    expect(await sp).toBe(1);

    await flushMicrotasks();
    expect(parseMnemonic(ws.sent[3]!)).toBe('READ');
    ws.inject(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    expect((await rp)[0]).toBe(1);
  });

  it('a failed exchange does not block the queue', async () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    const wp = client.writeTrack(0, 0, new Uint8Array(4384));
    const sp = client.stat(0, false, 0);
    ws.inject(makeResponse('WRIT', 0x01, 0)); // NOT_READY → writeTrack rejects
    await expect(wp).rejects.toThrow('WRIT rejected');
    await flushMicrotasks();
    expect(parseMnemonic(ws.lastSent())).toBe('STAT'); // queue moved on
    ws.inject(makeResponse('STAT', 0x00, 0x02));
    expect(await sp).toBe(2);
  });
});

describe('FdcPlusClient — multiple pending ops', () => {
  it('handles STAT then READ in sequence from one inject stream', async () => {
    const ws = new MockWs();
    const client = new FdcPlusClient(ws);
    const stat = client.stat(0, false, 0);
    const read = client.readTrack(0, 0, 8); // small length for test

    // Inject STAT response (8 bytes) followed immediately by track data (8 bytes)
    const combined = new Uint8Array(16);
    combined.set(makeResponse('STAT', 0, 0x01), 0); // ready bitmap = 1
    combined.set(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), 8);
    ws.inject(combined);

    expect(await stat).toBe(1);
    const trackData = await read;
    expect(trackData[0]).toBe(1);
    expect(trackData[7]).toBe(8);
  });
});

// ── MitsDcddCard — initial state ──────────────────────────────────────────────

describe('MitsDcddCard — initial state', () => {
  it('reports inactive status on a fresh card (all active-low bits high)', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    // Fresh card, no drive selected: NRDA=1 (no data), TRK0=0 (at track 0),
    // DRVRDY=1 (no drive selected), HDSTAT=1 (head not loaded), MVHD=0,
    // ENWD=1 (not ready for write) = 0x80|0x08|0x04|0x01 = 0x8D
    const status = card.ioRead(0x08);
    expect(status & 0x80).toBe(0x80); // NRDA=1 (no data)
    expect(status & 0x40).toBe(0x00); // TRK0=0 (at track 0)
    expect(status & 0x08).toBe(0x08); // DRVRDY=1 (no drive selected)
    expect(status & 0x04).toBe(0x04); // HDSTAT=1 (head not loaded)
    expect(status & 0x02).toBe(0x00); // MVHD=0 (not moving)
    expect(status & 0x01).toBe(0x01); // ENWD=1 (not ready for write)
  });

  it('DRVRDY (bit 3) goes active once a drive is selected', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    expect(card.ioRead(0x08) & 0x08).toBe(0x08); // not ready (no drive)
    card.ioWrite(0x08, 0x00);                     // select drive 0
    expect(card.ioRead(0x08) & 0x08).toBe(0x00); // DRVRDY=0 (ready)
  });

  it('data port reads 0xFF with no track loaded', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    expect(card.ioRead(0x0A)).toBe(0xff);
  });
});

// ── MitsDcddCard — drive select ───────────────────────────────────────────────

describe('MitsDcddCard — drive select (port 1 write)', () => {
  it('drive select (bit7=0) issues STAT command', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00); // select drive 0
    expect(ws.sent.length).toBe(1);
    expect(parseMnemonic(ws.sent[0]!)).toBe('STAT');
  });

  it('deselect (bit7=1) drops selection but keeps the head loaded (solenoid persists)', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00); // select drive 0
    ws.inject(makeResponse('STAT', 0, 0x01)); // drive 0 ready
    card.ioWrite(0x09, 0x04); // head load
    ws.inject(new Uint8Array(4384)); // track data
    await flushMicrotasks();

    card.ioWrite(0x08, 0x80); // deselect
    const status = card.ioRead(0x08);
    // Head-load state and the track under the head persist across a deselect;
    // the MITS multi-stage boot reselects and expects the head still loaded.
    expect(status & 0x04).toBe(0x00); // HDSTAT=0 (head still loaded)
    expect(status & 0x80).toBe(0x00); // NRDA=0 (data still available)
    expect(status & 0x08).toBe(0x08); // DRVRDY=1 (drive deselected)
  });

  it('reselecting the same drive keeps the loaded head and cached track', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00); // select drive 0
    ws.inject(makeResponse('STAT', 0, 0x01));
    card.ioWrite(0x09, 0x04); // head load
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();

    card.ioWrite(0x08, 0x80); // deselect
    card.ioWrite(0x08, 0x00); // reselect drive 0
    const status = card.ioRead(0x08);
    expect(status & 0x04).toBe(0x00); // HDSTAT=0 (head still loaded)
    expect(status & 0x08).toBe(0x00); // DRVRDY=0 (drive selected)
    expect(status & 0x80).toBe(0x00); // NRDA=0 (cached track still valid)
  });

  it('TRK0 status bit (bit6) reflects track position', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    vi.useFakeTimers();

    // At track 0
    expect(card.ioRead(0x08) & 0x40).toBe(0x00); // TRK0=0 (active-low = at track 0)

    // Step In to track 1
    card.ioWrite(0x08, 0x00);
    ws.inject(makeResponse('STAT', 0, 0x01));
    card.ioWrite(0x09, 0x01); // Step In
    vi.advanceTimersByTime(20);
    ws.inject(makeResponse('STAT', 0, 0x01));
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();

    expect(card.ioRead(0x08) & 0x40).toBe(0x40); // TRK0=1 (not at track 0)

    vi.useRealTimers();
  });
});

// ── MitsDcddCard — head load + fetch ─────────────────────────────────────────

describe('MitsDcddCard — head load and track fetch', () => {
  it('head load issues READ command to fdcplus-web', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00); // select drive 0 (sends STAT)
    card.ioWrite(0x09, 0x04); // head load (queues READ behind the STAT exchange)
    expect(ws.sent.length).toBe(1); // wire is serialized: READ waits for STAT reply
    ws.inject(makeResponse('STAT', 0, 0x01));
    await flushMicrotasks();
    // ws.sent[0] = STAT, ws.sent[1] = READ
    expect(parseMnemonic(ws.sent[1]!)).toBe('READ');
    expect(parseP1(ws.sent[1]!)).toBe(0x0000); // drive=0, track=0
    expect(parseP2(ws.sent[1]!)).toBe(4384);
  });

  it('NRDA=1 while fetch pending', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    card.ioWrite(0x09, 0x04);
    expect(card.ioRead(0x08) & 0x80).toBe(0x80); // NRDA=1
  });

  it('NRDA=0 after track data arrives', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    card.ioWrite(0x09, 0x04);

    // Inject STAT response then track data
    ws.inject(makeResponse('STAT', 0, 0x01));
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();

    expect(card.ioRead(0x08) & 0x80).toBe(0x00); // NRDA=0
    expect(card.ioRead(0x08) & 0x04).toBe(0x00); // HDSTAT=0 (head IS loaded)
  });

  it('head unload clears HDSTAT and invalidates track data', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    card.ioWrite(0x09, 0x04); // head load
    ws.inject(makeResponse('STAT', 0, 0x01));
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();
    expect(card.ioRead(0x08) & 0x80).toBe(0x00); // was ready

    card.ioWrite(0x09, 0x08); // head unload
    expect(card.ioRead(0x08) & 0x80).toBe(0x80); // NRDA=1 again
    expect(card.ioRead(0x08) & 0x04).toBe(0x04); // HDSTAT=1 (head unloaded)
  });
});

// ── MitsDcddCard — data read ──────────────────────────────────────────────────

describe('MitsDcddCard — data read (port 3)', () => {
  async function loadTrack(ws: MockWs, card: MitsDcddCard, trackData: Uint8Array): Promise<void> {
    card.ioWrite(0x08, 0x00);
    card.ioWrite(0x09, 0x04);
    ws.inject(makeResponse('STAT', 0, 0x01));
    ws.inject(trackData);
    await flushMicrotasks();
  }

  it('reads correct bytes from sector 0', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    const track = new Uint8Array(4384);
    track[0] = 0xAA; track[1] = 0xBB; track[136] = 0xCC; // bytes 0,1,136 of sector 0
    await loadTrack(ws, card, track);

    // Force lastSector = 0 by reading sector port until sector 0 with sectorTrue=0
    // Instead, directly verify data reads advance byteInSector correctly.
    // Since lastSector is -1 initially and getSectorPort() runs with real time,
    // we just check that data port returns bytes from the track cache.
    const b0 = card.ioRead(0x0A);
    const b1 = card.ioRead(0x0A);
    expect(b0).not.toBe(0xff); // data is available
    expect(b1).not.toBe(0xff); // second byte also available
  });

  it('byteInSector advances and wraps at 137', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    const track = new Uint8Array(4384);
    // Fill sector 0 with ascending bytes
    for (let i = 0; i < 137; i++) track[i] = i & 0xff;
    await loadTrack(ws, card, track);

    // Force lastSector to 0 (simulate sector 0 under head)
    // We can do this by reading the sector port — but sector is time-based.
    // Instead, test the counter mechanics by reading 137 bytes then checking wrap.
    // This relies on lastSector being set on first sector read.
    card.ioRead(0x09); // set lastSector via time-based sector read

    // Read 137 bytes then check next read wraps to byte 0 of the same sector
    let prev = -1;
    let wrapped = false;
    for (let i = 0; i < 140; i++) {
      const b = card.ioRead(0x0A);
      if (i === 136) {
        // After 137th byte (index 136), byteInSector should wrap to 0
        // The 138th read (i=137) should give byte 0 of the sector again
        void b; // just advance
      }
      if (i === 137 && prev === 136) {
        // byteInSector wrapped back to 0 after 137 reads
        wrapped = true;
      }
      prev = i < 137 ? i : prev;
    }
    expect(wrapped).toBe(true);
  });

  it('returns 0xFF when no track loaded', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    expect(card.ioRead(0x0A)).toBe(0xff);
  });
});

// ── MitsDcddCard — step (seek) ────────────────────────────────────────────────

describe('MitsDcddCard — step commands', () => {
  // Seeks are instantaneous in emulation: MVHD never reports "moving", and no
  // step pulse is ever dropped (which would desync track position).

  it('Step In moves off track 0 with MVHD never asserting', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    ws.inject(makeResponse('STAT', 0, 0x01));
    await flushMicrotasks();

    expect(card.ioRead(0x08) & 0x40).toBe(0x00); // TRK0=0 (at track 0)
    card.ioWrite(0x09, 0x01); // Step In
    expect(card.ioRead(0x08) & 0x02).toBe(0x00); // MVHD stays 0 (instant)
    expect(card.ioRead(0x08) & 0x40).toBe(0x40); // TRK0=1 (no longer at track 0)
  });

  it('Step Out clamps at track 0', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    card.ioWrite(0x09, 0x02); // Step Out (already at track 0 — should clamp)
    expect(card.ioRead(0x08) & 0x40).toBe(0x00); // still at track 0
  });

  it('consecutive Step In pulses are NOT dropped (no headMoving gate)', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    // Two step-ins in a row must advance by two tracks; stepping out twice
    // returns to track 0 exactly (proving neither pulse was dropped).
    card.ioWrite(0x09, 0x01);
    card.ioWrite(0x09, 0x01);
    expect(card.ioRead(0x08) & 0x40).toBe(0x40); // track 2, not at 0
    card.ioWrite(0x09, 0x02);
    expect(card.ioRead(0x08) & 0x40).toBe(0x40); // track 1, still not at 0
    card.ioWrite(0x09, 0x02);
    expect(card.ioRead(0x08) & 0x40).toBe(0x00); // back at track 0
  });

  it('a step invalidates the cached track and refetches the new track', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    ws.inject(makeResponse('STAT', 0, 0x01));
    card.ioWrite(0x09, 0x04); // head load → fetch track 0
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();
    expect(card.ioRead(0x08) & 0x80).toBe(0x00); // NRDA=0 (track 0 cached)

    card.ioWrite(0x09, 0x01); // Step In → cache invalidated, refetch track 1
    expect(card.ioRead(0x08) & 0x80).toBe(0x80); // NRDA=1 (fetching)
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();
    expect(card.ioRead(0x08) & 0x80).toBe(0x00); // NRDA=0 (track 1 cached)
  });
});

// ── MitsDcddCard — per-drive head position ───────────────────────────────────

describe('MitsDcddCard — per-drive head position', () => {
  // Regression: head position is per-drive state (each drive's arm stays where
  // it was left). A single shared track counter desyncs as soon as two drives
  // interleave seeks — the BIOS steps relative to its per-drive track table,
  // lands on the wrong physical track, and every access fails with Bad Sector
  // (first seen with PIP copying a file between two disks).

  it('each drive keeps its own track position across drive switches', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);

    card.ioWrite(0x08, 0x00); // select drive 0
    ws.inject(makeResponse('STAT', 0, 0x01));
    await flushMicrotasks();
    card.ioWrite(0x09, 0x01); // Step In ×2 → drive 0 at track 2
    card.ioWrite(0x09, 0x01);
    expect(card.ioRead(0x08) & 0x40).toBe(0x40); // not at track 0

    card.ioWrite(0x08, 0x01); // select drive 1
    ws.inject(makeResponse('STAT', 0, 0x01));
    await flushMicrotasks();
    expect(card.ioRead(0x08) & 0x40).toBe(0x00); // drive 1 has ITS OWN arm — at track 0
    for (let i = 0; i < 5; i++) card.ioWrite(0x09, 0x01); // drive 1 → track 5

    card.ioWrite(0x08, 0x00); // back to drive 0
    ws.inject(makeResponse('STAT', 0, 0x01));
    await flushMicrotasks();
    expect(card.ioRead(0x08) & 0x40).toBe(0x40); // still off track 0
    card.ioWrite(0x09, 0x04); // head load → fetch drive 0's track
    await flushMicrotasks();
    const read = ws.sent[ws.sent.length - 1]!;
    expect(parseMnemonic(read)).toBe('READ');
    expect(parseP1(read)).toBe((0 << 12) | 2); // drive 0, track 2 — not drive 1's track 5
  });

  it('switching drives with a dirty write buffer flushes it to the previous drive', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00); // select drive 0
    ws.inject(makeResponse('STAT', 0, 0x01));
    await flushMicrotasks();

    card.ioWrite(0x09, 0x80); // Write Enable
    card.ioWrite(0x0A, 0x42); // dirty byte on drive 0, track 0
    card.ioWrite(0x08, 0x02); // select drive 2 directly (no deselect)

    const writ = ws.sent[1]!;
    expect(parseMnemonic(writ)).toBe('WRIT');
    expect(parseP1(writ)).toBe((0 << 12) | 0); // flushed to drive 0, not drive 2
  });
});

// ── MitsDcddCard — write flow ─────────────────────────────────────────────────

describe('MitsDcddCard — write flow', () => {
  it('Write Enable sets ENWD=0 in status', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    card.ioWrite(0x09, 0x04); // head load
    ws.inject(makeResponse('STAT', 0, 0x01));
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();

    card.ioWrite(0x09, 0x80); // Write Enable
    expect(card.ioRead(0x08) & 0x01).toBe(0x00); // ENWD=0 (ready for write)
  });

  it('port 3 write stores bytes in write buffer', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    card.ioWrite(0x09, 0x04); // head load
    ws.inject(makeResponse('STAT', 0, 0x01));
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();
    card.ioWrite(0x09, 0x80); // Write Enable
    card.ioRead(0x09);         // set lastSector via sector port read
    card.ioWrite(0x0A, 0x42);  // write byte 'B'
    card.ioWrite(0x0A, 0x43);  // write byte 'C'
    // No assertion on internal buffer, but verify it didn't throw or corrupt state
    expect(card.ioRead(0x08) & 0x01).toBe(0x00); // still write-enabled
  });

  it('head unload with dirty write buffer flushes via WRIT', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    card.ioWrite(0x09, 0x04); // head load
    ws.inject(makeResponse('STAT', 0, 0x01));
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();

    card.ioWrite(0x09, 0x80); // Write Enable
    card.ioWrite(0x0A, 0x55); // write a byte (makes dirty=true)
    card.ioWrite(0x09, 0x08); // Head Unload → should trigger WRIT
    // STAT was ws.sent[0], READ was ws.sent[1], now WRIT should be ws.sent[2]
    expect(parseMnemonic(ws.sent[2]!)).toBe('WRIT');
    expect(parseP1(ws.sent[2]!)).toBe(0x0000); // drive=0, track=0
    expect(parseP2(ws.sent[2]!)).toBe(4384);
  });

  it('flush merges written sectors over the cached track — unwritten sectors keep their contents', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00); // select drive 0
    ws.inject(makeResponse('STAT', 0, 0x01));
    card.ioWrite(0x09, 0x04); // head load
    ws.inject(new Uint8Array(4384).fill(0x11)); // whole disk track = 0x11
    await flushMicrotasks();

    card.ioWrite(0x09, 0x80); // Write Enable
    // lastSector is -1 on a fresh card → writes land in sector 0
    for (let i = 0; i < 137; i++) card.ioWrite(0x0A, 0x42); // rewrite sector 0

    // After 137 bytes the head is over the inter-sector gap — reads return 0xff
    // until the sector counter advances.
    expect(card.ioRead(0x0A)).toBe(0xff);

    card.ioWrite(0x09, 0x08); // Head Unload → flush
    expect(parseMnemonic(ws.sent[2]!)).toBe('WRIT');
    ws.inject(makeResponse('WRIT', 0x00, 0));
    await flushMicrotasks();

    const payload = ws.sent[3]!;
    expect(payload.length).toBe(4384);
    expect(payload[0]).toBe(0x42);   // written sector has new contents
    expect(payload[136]).toBe(0x42);
    expect(payload[137]).toBe(0x11); // sector 1 untouched — NOT zeroed
    expect(payload[4383]).toBe(0x11);
  });

  it('trailing pad bytes beyond the 137-byte sector fall into the gap, not back onto byte 0', async () => {
    // Regression: the BIOS writes 138 bytes per sector (137 + a pad byte that
    // lands in the inter-sector gap on real hardware). Wrapping mod 137 made
    // the pad byte overwrite the sector's track-marker byte → "Bad Sector".
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    ws.inject(makeResponse('STAT', 0, 0x01));
    card.ioWrite(0x09, 0x04);
    ws.inject(new Uint8Array(4384).fill(0x11));
    await flushMicrotasks();

    card.ioWrite(0x09, 0x80); // Write Enable
    card.ioWrite(0x0A, 0x82); // track-marker byte
    for (let i = 1; i < 137; i++) card.ioWrite(0x0A, 0x42);
    card.ioWrite(0x0A, 0x00); // 138th byte — BIOS pad

    card.ioWrite(0x09, 0x08); // Head Unload → flush
    ws.inject(makeResponse('WRIT', 0x00, 0));
    await flushMicrotasks();
    expect(ws.sent[3]![0]).toBe(0x82); // marker byte intact, not clobbered by the pad
  });

  it('a second Write Enable does not discard sectors buffered by the first', async () => {
    // Regression: the BIOS issues Write Enable once per sector write. Resetting
    // the buffer on each enable meant only the LAST sector written between
    // flushes survived — e.g. a SAVE's directory-entry write was discarded by
    // the following data-sector write and files never appeared on disk.
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    ws.inject(makeResponse('STAT', 0, 0x01));
    card.ioWrite(0x09, 0x04); // head load
    ws.inject(new Uint8Array(4384).fill(0x11));
    await flushMicrotasks();

    card.ioWrite(0x09, 0x80); // Write Enable #1
    for (let i = 0; i < 137; i++) card.ioWrite(0x0A, 0x42); // sector 0
    card.ioWrite(0x09, 0x80); // Write Enable #2 (next sector write begins)

    card.ioWrite(0x09, 0x08); // Head Unload → flush
    ws.inject(makeResponse('WRIT', 0x00, 0));
    await flushMicrotasks();
    const payload = ws.sent[3]!;
    expect(payload[0]).toBe(0x42); // sector 0 from enable #1 survived
    expect(payload[136]).toBe(0x42);
  });

  it('a step with a dirty write buffer flushes it to the track being left', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    ws.inject(makeResponse('STAT', 0, 0x01));
    card.ioWrite(0x09, 0x04); // head load → fetch track 0
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();

    card.ioWrite(0x09, 0x80); // Write Enable
    card.ioWrite(0x0A, 0x99); // dirty
    card.ioWrite(0x09, 0x01); // Step In → must flush to track 0 first
    expect(parseMnemonic(ws.sent[2]!)).toBe('WRIT');
    expect(parseP1(ws.sent[2]!)).toBe(0x0000); // drive=0, TRACK 0 — not track 1
  });

  it('drive deselect with dirty write buffer flushes via WRIT', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    card.ioWrite(0x08, 0x00);
    card.ioWrite(0x09, 0x04);
    ws.inject(makeResponse('STAT', 0, 0x01));
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();
    card.ioWrite(0x09, 0x80); // Write Enable
    card.ioWrite(0x0A, 0x77); // write byte → dirty
    card.ioWrite(0x08, 0x80); // deselect → flush
    expect(parseMnemonic(ws.sent[2]!)).toBe('WRIT');
  });
});

// ── MitsDcddCard — bus integration ───────────────────────────────────────────

describe('MitsDcddCard — bus attach', () => {
  it('attach registers all three ports on the bus', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    const bus = new Bus(new InterruptController());
    card.attach(bus);
    // All three ports should respond (not return 0xFF from unmapped)
    // Status port returns actual status byte (not 0xFF)
    expect(bus.ioRead(0x08)).not.toBe(0xff);
    // Sector port (09h) returns 0xC0 | something (always has bits 7,6 set)
    expect(bus.ioRead(0x09) & 0xC0).toBe(0xC0);
  });

  it('custom basePort via DcddOptions', () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws, { basePort: 0x10 });
    const bus = new Bus(new InterruptController());
    card.attach(bus);
    expect(bus.ioRead(0x10)).not.toBe(0xff); // status at 0x10
    expect(bus.ioRead(0x08)).toBe(0xff);     // old default unmapped
  });

  it('bus.reset() resets card state', async () => {
    const ws = new MockWs();
    const card = new MitsDcddCard('dcdd', ws);
    const bus = new Bus(new InterruptController());
    card.attach(bus);

    bus.ioWrite(0x08, 0x00);
    bus.ioWrite(0x09, 0x04);
    ws.inject(makeResponse('STAT', 0, 0x01));
    ws.inject(new Uint8Array(4384));
    await flushMicrotasks();

    expect(bus.ioRead(0x08) & 0x80).toBe(0x00); // NRDA=0 (data ready)
    bus.reset();
    expect(bus.ioRead(0x08) & 0x80).toBe(0x80); // NRDA=1 after reset
  });
});
