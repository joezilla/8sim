import { describe, it, expect, vi } from 'vitest';
import { Tr1602Uart } from '../../src/cards/Tr1602Uart.js';
import { Port8212 } from '../../src/cards/Port8212.js';
import { ImsaiMioCard } from '../../src/cards/ImsaiMioCard.js';
import { Bus } from '../../src/bus/Bus.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';

// ── Tr1602Uart ──────────────────────────────────────────────────────────────

describe('Tr1602Uart', () => {
  const DATA = 0x12;
  const STAT = 0x13;
  const mk = () => new Tr1602Uart('uart', DATA, STAT);

  it('exposes its two ports', () => {
    expect(mk().basePorts).toEqual([DATA, STAT]);
  });

  it('idle status is TxRDY + TxEMPTY (0x05) with no init required', () => {
    // No mode/command writes needed — the UART is ready from power-on.
    expect(mk().ioRead(STAT)).toBe(0x05);
  });

  it('transmits immediately on data write (always ready, no CTS gating)', () => {
    const uart = mk();
    const tx = vi.fn();
    uart.onTransmit(tx);
    uart.ioWrite(DATA, 0x41);
    expect(tx).toHaveBeenCalledWith(0x41);
    expect(uart.ioRead(STAT) & 0x01).toBe(0x01); // TxRDY still high
  });

  it('RxRDY reflects a queued received byte and clears on read', () => {
    const uart = mk();
    expect(uart.ioRead(STAT) & 0x02).toBe(0x00); // no data
    uart.enqueueRx(0x37);
    expect(uart.ioRead(STAT) & 0x02).toBe(0x02); // RxRDY set
    expect(uart.ioRead(DATA)).toBe(0x37);        // read the byte
    expect(uart.ioRead(STAT) & 0x02).toBe(0x00); // RxRDY cleared
  });

  it('data read returns 0xFF when no byte is available', () => {
    expect(mk().ioRead(DATA)).toBe(0xff);
  });

  it('delivers received bytes in FIFO order', () => {
    const uart = mk();
    uart.enqueueRx(0x11);
    uart.enqueueRx(0x22);
    expect(uart.ioRead(DATA)).toBe(0x11);
    expect(uart.ioRead(DATA)).toBe(0x22);
  });

  it('flags overrun (OE, bit 4) when a byte arrives before the buffer is read', () => {
    const uart = mk();
    uart.enqueueRx(0x01);
    uart.enqueueRx(0x02); // arrives while buffer still full → overrun
    expect(uart.ioRead(STAT) & 0x10).toBe(0x10); // OE set
  });

  it('injects parity/overrun/framing error flags into bits 3-5', () => {
    const uart = mk();
    uart.setErrors(true, false, true); // PE + FE
    const s = uart.ioRead(STAT);
    expect(s & 0x08).toBe(0x08); // PE (bit 3)
    expect(s & 0x10).toBe(0x00); // OE (bit 4) clear
    expect(s & 0x20).toBe(0x20); // FE (bit 5)
  });

  it('status port write goes to the control register (not transmit)', () => {
    const uart = mk();
    const tx = vi.fn();
    const ctrl = vi.fn();
    uart.onTransmit(tx);
    uart.onControl(ctrl);
    uart.ioWrite(STAT, 0x03); // DTR + RTS
    expect(ctrl).toHaveBeenCalledWith(0x03);
    expect(uart.control).toBe(0x03);
    expect(tx).not.toHaveBeenCalled();
  });

  it('reset clears rx queue, errors, and control register', () => {
    const uart = mk();
    uart.enqueueRx(0x99);
    uart.setErrors(true, true, true);
    uart.ioWrite(STAT, 0xff);
    uart.reset();
    expect(uart.ioRead(STAT)).toBe(0x05); // back to idle
    expect(uart.control).toBe(0x00);
    expect(uart.ioRead(DATA)).toBe(0xff);
  });
});

// ── Port8212 ────────────────────────────────────────────────────────────────

describe('Port8212', () => {
  it('reads floating-high (0xFF) inputs by default', () => {
    expect(new Port8212('p', 0x10).ioRead(0x10)).toBe(0xff);
  });

  it('reads the value driven onto its input pins', () => {
    const p = new Port8212('p', 0x10);
    p.setInput(0x5a);
    expect(p.ioRead(0x10)).toBe(0x5a);
  });

  it('latches the output byte on write and exposes it', () => {
    const p = new Port8212('p', 0x10);
    const cb = vi.fn();
    p.onWrite(cb);
    p.ioWrite(0x10, 0xa5);
    expect(p.output).toBe(0xa5);
    expect(cb).toHaveBeenCalledWith(0xa5);
  });

  it('output and input are independent', () => {
    const p = new Port8212('p', 0x10);
    p.setInput(0x0f);
    p.ioWrite(0x10, 0xf0);
    expect(p.ioRead(0x10)).toBe(0x0f); // input unaffected by output write
    expect(p.output).toBe(0xf0);
  });

  it('reset clears the output latch and restores floating-high input', () => {
    const p = new Port8212('p', 0x10);
    p.setInput(0x00);
    p.ioWrite(0x10, 0xff);
    p.reset();
    expect(p.output).toBe(0x00);
    expect(p.ioRead(0x10)).toBe(0xff);
  });
});

// ── ImsaiMioCard ────────────────────────────────────────────────────────────

describe('ImsaiMioCard', () => {
  it('maps four consecutive ports from the default base 0x10', () => {
    const mio = new ImsaiMioCard('mio');
    expect(mio.portA.basePorts).toEqual([0x10]);
    expect(mio.portB.basePorts).toEqual([0x11]);
    expect(mio.uart.basePorts).toEqual([0x12, 0x13]); // data, status
  });

  it('relocates all ports with a custom base (0x00 → serial 0x02/0x03)', () => {
    const mio = new ImsaiMioCard('mio', { basePort: 0x00 });
    expect(mio.portA.basePorts).toEqual([0x00]);
    expect(mio.portB.basePorts).toEqual([0x01]);
    expect(mio.uart.basePorts).toEqual([0x02, 0x03]);
  });

  it('attach registers all four ports on the bus', () => {
    const mio = new ImsaiMioCard('mio');
    const bus = new Bus(new InterruptController());
    mio.attach(bus);
    // Serial status readable (idle 0x05), not the 0xFF of an unmapped port.
    expect(bus.ioRead(0x13)).toBe(0x05);
    // Parallel ports respond (floating-high default).
    expect(bus.ioRead(0x10)).toBe(0xff);
    expect(bus.ioRead(0x11)).toBe(0xff);
  });

  it('serial console output flows through the bus', () => {
    const mio = new ImsaiMioCard('mio');
    const bus = new Bus(new InterruptController());
    mio.attach(bus);
    let out = '';
    mio.uart.onTransmit((b) => { out += String.fromCharCode(b); });

    // Poll TxRDY (bit 0) then write — the canonical MIO putchar loop.
    for (const ch of 'HI') {
      expect(bus.ioRead(0x13) & 0x01).toBe(0x01); // TxRDY always ready
      bus.ioWrite(0x12, ch.charCodeAt(0));
    }
    expect(out).toBe('HI');
  });

  it('received input is read back through the data port on the bus', () => {
    const mio = new ImsaiMioCard('mio');
    const bus = new Bus(new InterruptController());
    mio.attach(bus);
    mio.uart.enqueueRx(0x7e);
    expect(bus.ioRead(0x13) & 0x02).toBe(0x02); // RxRDY
    expect(bus.ioRead(0x12)).toBe(0x7e);         // data
  });

  it('parallel port output latches through the bus', () => {
    const mio = new ImsaiMioCard('mio');
    const bus = new Bus(new InterruptController());
    mio.attach(bus);
    bus.ioWrite(0x10, 0xcc);
    expect(mio.portA.output).toBe(0xcc);
    mio.portB.setInput(0x33);
    expect(bus.ioRead(0x11)).toBe(0x33);
  });

  it('bus.reset() resets card state', () => {
    const mio = new ImsaiMioCard('mio');
    const bus = new Bus(new InterruptController());
    mio.attach(bus);
    bus.ioWrite(0x10, 0xff);   // latch parallel output
    mio.uart.enqueueRx(0x41);  // queue a received byte
    bus.reset();
    expect(mio.portA.output).toBe(0x00);
    expect(bus.ioRead(0x13) & 0x02).toBe(0x00); // rx queue drained
  });
});
