import { describe, it, expect, vi } from 'vitest';
import { Usart8251 } from '../../src/cards/Usart8251.js';

const DATA = 0x02;
const CTRL = 0x03;

function makeUsart(): Usart8251 {
  return new Usart8251('test', DATA, CTRL);
}

function initUsart(u: Usart8251, { txEn = false, rxEn = false } = {}): void {
  u.ioWrite(CTRL, 0x4e); // mode: 8N1 ÷16
  u.ioWrite(CTRL, (txEn ? 0x01 : 0) | (rxEn ? 0x04 : 0));
}

describe('Usart8251 — state machine', () => {
  it('starts in mode phase: status has TxEMPTY set, TxRDY/RxRDY clear', () => {
    const u = makeUsart();
    expect(u.ioRead(CTRL) & 0x07).toBe(0x04); // TxEMPTY=1, others 0
  });

  it('first ctrl write is mode word, transitions to command phase', () => {
    const u = makeUsart();
    u.ioWrite(CTRL, 0x4e);
    u.ioWrite(CTRL, 0x01); // TxEN=1
    expect(u.ioRead(CTRL) & 0x01).toBe(1); // TxRDY set
  });

  it('IR bit (0x40) during command phase resets to mode phase', () => {
    const u = makeUsart();
    initUsart(u, { txEn: true });
    expect(u.ioRead(CTRL) & 0x01).toBe(1);
    u.ioWrite(CTRL, 0x40); // Internal Reset
    expect(u.ioRead(CTRL) & 0x01).toBe(0); // TxRDY gone
    // Next write must be mode word again
    u.ioWrite(CTRL, 0x4e); // mode
    u.ioWrite(CTRL, 0x01); // command: TxEN=1
    expect(u.ioRead(CTRL) & 0x01).toBe(1);
  });

  it('3-byte flush sequence + IR leaves chip ready for mode word', () => {
    const u = makeUsart();
    u.ioWrite(CTRL, 0x00);
    u.ioWrite(CTRL, 0x00);
    u.ioWrite(CTRL, 0x00);
    u.ioWrite(CTRL, 0x40); // IR
    u.ioWrite(CTRL, 0x4e); // mode
    u.ioWrite(CTRL, 0x01); // command: TxEN=1
    expect(u.ioRead(CTRL) & 0x01).toBe(1);
  });
});

describe('Usart8251 — status bits', () => {
  it('TxRDY is 0 with no init', () => {
    const u = makeUsart();
    expect(u.ioRead(CTRL) & 0x01).toBe(0);
  });

  it('TxRDY is 1 after mode+command with TxEN=1 (CTS active by default)', () => {
    const u = makeUsart();
    initUsart(u, { txEn: true });
    expect(u.ioRead(CTRL) & 0x01).toBe(1);
  });

  it('TxRDY is 0 when TxEN=0', () => {
    const u = makeUsart();
    initUsart(u, { txEn: false });
    expect(u.ioRead(CTRL) & 0x01).toBe(0);
  });

  it('TxRDY is 0 when CTS inactive even with TxEN=1', () => {
    const u = makeUsart();
    u.setCts(false);
    initUsart(u, { txEn: true });
    expect(u.ioRead(CTRL) & 0x01).toBe(0);
  });

  it('RxRDY is 0 with no init', () => {
    const u = makeUsart();
    expect(u.ioRead(CTRL) & 0x02).toBe(0);
  });

  it('RxRDY is 1 after mode+command(RxE=1) and byte enqueued', () => {
    const u = makeUsart();
    u.enqueueRx(0x42);
    initUsart(u, { rxEn: true });
    expect(u.ioRead(CTRL) & 0x02).toBe(2);
  });

  it('RxRDY is 0 when RxE=0 even with bytes in queue', () => {
    const u = makeUsart();
    u.enqueueRx(0x42);
    initUsart(u, { rxEn: false });
    expect(u.ioRead(CTRL) & 0x02).toBe(0);
  });

  it('TxEMPTY (bit 2) is always 1', () => {
    const u = makeUsart();
    expect(u.ioRead(CTRL) & 0x04).toBe(0x04);
    initUsart(u, { txEn: true, rxEn: true });
    expect(u.ioRead(CTRL) & 0x04).toBe(0x04);
  });

  it('DSR (bit 7) reflects setDsr', () => {
    const u = makeUsart();
    expect(u.ioRead(CTRL) & 0x80).toBe(0x80); // default active
    u.setDsr(false);
    expect(u.ioRead(CTRL) & 0x80).toBe(0);
    u.setDsr(true);
    expect(u.ioRead(CTRL) & 0x80).toBe(0x80);
  });
});

describe('Usart8251 — TX path', () => {
  it('transmitCb is called with byte when TxEN and CTS active', () => {
    const u = makeUsart();
    const cb = vi.fn();
    u.onTransmit(cb);
    initUsart(u, { txEn: true });
    u.ioWrite(DATA, 0x41);
    expect(cb).toHaveBeenCalledWith(0x41);
  });

  it('transmitCb is not called when TxEN=0', () => {
    const u = makeUsart();
    const cb = vi.fn();
    u.onTransmit(cb);
    initUsart(u, { txEn: false });
    u.ioWrite(DATA, 0x41);
    expect(cb).not.toHaveBeenCalled();
  });

  it('transmitCb is not called when CTS inactive', () => {
    const u = makeUsart();
    const cb = vi.fn();
    u.onTransmit(cb);
    u.setCts(false);
    initUsart(u, { txEn: true });
    u.ioWrite(DATA, 0x41);
    expect(cb).not.toHaveBeenCalled();
  });

  it('byte is masked to 8 bits before calling transmitCb', () => {
    const u = makeUsart();
    const cb = vi.fn();
    u.onTransmit(cb);
    initUsart(u, { txEn: true });
    u.ioWrite(DATA, 0x141);
    expect(cb).toHaveBeenCalledWith(0x41);
  });

  it('setCts(true) restores TX after being disabled', () => {
    const u = makeUsart();
    const cb = vi.fn();
    u.onTransmit(cb);
    u.setCts(false);
    initUsart(u, { txEn: true });
    u.ioWrite(DATA, 0x41);
    expect(cb).not.toHaveBeenCalled();
    u.setCts(true);
    u.ioWrite(DATA, 0x42);
    expect(cb).toHaveBeenCalledWith(0x42);
  });
});

describe('Usart8251 — RX path', () => {
  it('reading data port drains queue in FIFO order', () => {
    const u = makeUsart();
    u.enqueueRx(0x41);
    u.enqueueRx(0x42);
    initUsart(u, { rxEn: true });
    expect(u.ioRead(DATA)).toBe(0x41);
    expect(u.ioRead(DATA)).toBe(0x42);
  });

  it('RxRDY clears after last byte is read', () => {
    const u = makeUsart();
    u.enqueueRx(0x41);
    initUsart(u, { rxEn: true });
    expect(u.ioRead(CTRL) & 0x02).toBe(2);
    u.ioRead(DATA);
    expect(u.ioRead(CTRL) & 0x02).toBe(0);
  });

  it('reading empty data port returns 0xFF', () => {
    const u = makeUsart();
    expect(u.ioRead(DATA)).toBe(0xff);
  });

  it('data port read drains queue regardless of RxE', () => {
    const u = makeUsart();
    u.enqueueRx(0x41);
    initUsart(u, { rxEn: false });
    expect(u.ioRead(DATA)).toBe(0x41);
  });
});

describe('Usart8251 — ER bit', () => {
  it('writing command with ER bit (0x10) clears error flags', () => {
    const u = makeUsart();
    initUsart(u);
    // Force a non-zero errorFlags state by re-writing a command with errors cleared from
    // previous; the main observable is that writing 0x37 (CMD_ERRRST) then 0x27 leaves
    // no error bits (bits 3-5) in status.
    u.ioWrite(CTRL, 0x37); // TxEN + RxE + ER
    expect(u.ioRead(CTRL) & 0x38).toBe(0);
    u.ioWrite(CTRL, 0x27); // TxEN + RxE, no ER
    expect(u.ioRead(CTRL) & 0x38).toBe(0);
  });
});

describe('Usart8251 — reset()', () => {
  it('reset clears phase, enables, rxQueue', () => {
    const u = makeUsart();
    u.enqueueRx(0x41);
    initUsart(u, { txEn: true, rxEn: true });
    u.reset();
    expect(u.ioRead(CTRL) & 0x03).toBe(0); // TxRDY=0, RxRDY=0
    expect(u.ioRead(DATA)).toBe(0xff);       // queue flushed
  });

  it('reset preserves transmitCb', () => {
    const u = makeUsart();
    const cb = vi.fn();
    u.onTransmit(cb);
    u.reset();
    initUsart(u, { txEn: true });
    u.ioWrite(DATA, 0x41);
    expect(cb).toHaveBeenCalledWith(0x41);
  });

  it('reset preserves CTS and DSR state', () => {
    const u = makeUsart();
    u.setCts(false);
    u.setDsr(false);
    u.reset();
    // After reset, phase=mode so need to re-init before checking TxRDY
    initUsart(u, { txEn: true });
    expect(u.ioRead(CTRL) & 0x01).toBe(0); // CTS still inactive
    expect(u.ioRead(CTRL) & 0x80).toBe(0); // DSR still inactive
  });

  it('IR during command phase flushes rxQueue', () => {
    const u = makeUsart();
    u.enqueueRx(0x41);
    initUsart(u, { rxEn: true });
    u.ioWrite(CTRL, 0x40); // IR
    // phase is now mode; rxQueue flushed
    u.ioWrite(CTRL, 0x4e); // re-init mode
    u.ioWrite(CTRL, 0x04); // RxE=1
    expect(u.ioRead(CTRL) & 0x02).toBe(0); // queue was flushed
  });
});
