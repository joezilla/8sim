import { describe, it, expect, vi } from 'vitest';
import { Mc6850Acia } from '../../src/cards/Mc6850Acia.js';
import { Mits2SioCard } from '../../src/cards/Mits2SioCard.js';
import { Bus } from '../../src/bus/Bus.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';

// ── Mc6850Acia ──────────────────────────────────────────────────────────────

describe('Mc6850Acia', () => {
  const STAT = 0x10;
  const DATA = 0x11;
  const mk = () => new Mc6850Acia('acia', STAT, DATA);

  it('exposes status port at the lower address, data at the higher', () => {
    expect(mk().basePorts).toEqual([STAT, DATA]);
  });

  it('idle status is TDRE with DCD/CTS grounded (ready to transmit)', () => {
    // CTS clear + carrier present by default → only TDRE (bit1) set.
    expect(mk().ioRead(STAT)).toBe(0x02);
  });

  it('master reset (03h) then config write is accepted', () => {
    const acia = mk();
    acia.ioWrite(STAT, 0x03); // master reset
    acia.ioWrite(STAT, 0x15); // 8N1, ÷16, no interrupts
    expect(acia.control).toBe(0x15);
    expect(acia.ioRead(STAT) & 0x02).toBe(0x02); // TDRE ready
  });

  it('transmits on data write and keeps TDRE high', () => {
    const acia = mk();
    const tx = vi.fn();
    acia.onTransmit(tx);
    acia.ioWrite(DATA, 0x41);
    expect(tx).toHaveBeenCalledWith(0x41);
    expect(acia.ioRead(STAT) & 0x02).toBe(0x02);
  });

  it('CTS not clear inhibits TDRE and suppresses transmit', () => {
    const acia = mk();
    const tx = vi.fn();
    acia.onTransmit(tx);
    acia.setCts(false);
    expect(acia.ioRead(STAT) & 0x02).toBe(0x00); // TDRE inhibited
    expect(acia.ioRead(STAT) & 0x08).toBe(0x08); // CTS bit set (not clear)
    acia.ioWrite(DATA, 0x55);
    expect(tx).not.toHaveBeenCalled();
  });

  it('RDRF reflects a queued byte and clears on read (FIFO order)', () => {
    const acia = mk();
    expect(acia.ioRead(STAT) & 0x01).toBe(0x00);
    acia.enqueueRx(0x61);
    acia.enqueueRx(0x62);
    expect(acia.ioRead(STAT) & 0x01).toBe(0x01); // RDRF
    expect(acia.ioRead(DATA)).toBe(0x61);
    expect(acia.ioRead(DATA)).toBe(0x62);
    expect(acia.ioRead(STAT) & 0x01).toBe(0x00); // drained
  });

  it('lost carrier (DCD) clamps RDRF to 0 and sets the DCD status bit', () => {
    const acia = mk();
    acia.enqueueRx(0x7a);
    acia.setDcd(false); // carrier lost
    const s = acia.ioRead(STAT);
    expect(s & 0x01).toBe(0x00); // RDRF clamped
    expect(s & 0x04).toBe(0x04); // DCD bit set
  });

  it('flags overrun (OVRN, bit 5) when a byte arrives before the buffer is read', () => {
    const acia = mk();
    acia.enqueueRx(0x01);
    acia.enqueueRx(0x02);
    expect(acia.ioRead(STAT) & 0x20).toBe(0x20);
  });

  it('injects framing/overrun/parity errors into bits 4-6', () => {
    const acia = mk();
    acia.setErrors(true, false, true); // FE + PE
    const s = acia.ioRead(STAT);
    expect(s & 0x10).toBe(0x10); // FE (bit 4)
    expect(s & 0x20).toBe(0x00); // OVRN (bit 5) clear
    expect(s & 0x40).toBe(0x40); // PE (bit 6)
  });

  it('raises IRQ (bit 7) when receive interrupts are enabled and RDRF is set', () => {
    const acia = mk();
    acia.ioWrite(STAT, 0x95); // 8N1, ÷16, RX interrupt enable (bit7)
    expect(acia.ioRead(STAT) & 0x80).toBe(0x00); // no data yet
    acia.enqueueRx(0x40);
    expect(acia.ioRead(STAT) & 0x80).toBe(0x80); // IRQ asserted
  });

  it('raises IRQ when transmit interrupts are enabled (bits 6-5 = 01) and TDRE set', () => {
    const acia = mk();
    acia.ioWrite(STAT, 0x35); // bits6-5=01 (TX int), 8N1, ÷16
    expect(acia.ioRead(STAT) & 0x80).toBe(0x80); // TDRE ready → IRQ
  });

  it('master reset clears a pending received byte and interrupt enables', () => {
    const acia = mk();
    acia.ioWrite(STAT, 0x95); // enable RX interrupts
    acia.enqueueRx(0x99);
    acia.ioWrite(STAT, 0x03); // master reset
    const s = acia.ioRead(STAT);
    expect(s & 0x01).toBe(0x00); // RDRF cleared
    expect(s & 0x80).toBe(0x00); // IRQ cleared (RX int disabled by reset)
  });
});

// ── Mits2SioCard ────────────────────────────────────────────────────────────

describe('Mits2SioCard', () => {
  it('maps two ACIAs across four ports from the default base 0x10', () => {
    const sio = new Mits2SioCard('2sio');
    expect(sio.port0.basePorts).toEqual([0x10, 0x11]); // status, data
    expect(sio.port1.basePorts).toEqual([0x12, 0x13]);
  });

  it('relocates both ports with a custom base', () => {
    const sio = new Mits2SioCard('2sio', { basePort: 0x14 });
    expect(sio.port0.basePorts).toEqual([0x14, 0x15]);
    expect(sio.port1.basePorts).toEqual([0x16, 0x17]);
  });

  it('attach registers all four ports on the bus', () => {
    const sio = new Mits2SioCard('2sio');
    const bus = new Bus(new InterruptController());
    sio.attach(bus);
    expect(bus.ioRead(0x10)).toBe(0x02); // Port 0 status (TDRE)
    expect(bus.ioRead(0x12)).toBe(0x02); // Port 1 status
  });

  it('runs the canonical init + transmit sequence over the bus', () => {
    const sio = new Mits2SioCard('2sio');
    const bus = new Bus(new InterruptController());
    sio.attach(bus);
    let out = '';
    sio.port0.onTransmit((b) => { out += String.fromCharCode(b); });

    bus.ioWrite(0x10, 0x03); // master reset
    bus.ioWrite(0x10, 0x15); // 8N1, ÷16
    for (const ch of 'HI') {
      // putchar: poll TDRE (bit 1) then write data
      expect(bus.ioRead(0x10) & 0x02).toBe(0x02);
      bus.ioWrite(0x11, ch.charCodeAt(0));
    }
    expect(out).toBe('HI');
  });

  it('receives input through the data port on the bus', () => {
    const sio = new Mits2SioCard('2sio');
    const bus = new Bus(new InterruptController());
    sio.attach(bus);
    sio.port0.enqueueRx(0x7e);
    expect(bus.ioRead(0x10) & 0x01).toBe(0x01); // RDRF
    expect(bus.ioRead(0x11)).toBe(0x7e);
  });

  it('bus.reset() resets both ACIAs', () => {
    const sio = new Mits2SioCard('2sio');
    const bus = new Bus(new InterruptController());
    sio.attach(bus);
    sio.port0.enqueueRx(0x41);
    sio.port1.enqueueRx(0x42);
    bus.reset();
    expect(bus.ioRead(0x10) & 0x01).toBe(0x00);
    expect(bus.ioRead(0x12) & 0x01).toBe(0x00);
  });
});
