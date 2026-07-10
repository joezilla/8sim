import { describe, it, expect, vi } from 'vitest';
import { Bus } from '../../src/bus/Bus.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { ImsaiSioCard } from '../../src/cards/ImsaiSioCard.js';

function makeBus(): Bus {
  return new Bus(new InterruptController());
}

describe('ImsaiSioCard — attach and port layout', () => {
  it('after attach, ctrl port A returns a status byte (not 0xFF)', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    // TxEMPTY (bit 2) is always 1; DSR (bit 7) is 1 by default = 0x84
    expect(bus.ioRead(0x03)).toBe(0x84);
  });

  it('after attach, ctrl port B returns a status byte (not 0xFF)', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    expect(bus.ioRead(0x05)).toBe(0x84);
  });

  it('board ctrl port is registered (returns 0xFF on read)', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    expect(bus.ioRead(0x08)).toBe(0xff);
  });

  it('default ports: A at 0x02/0x03, B at 0x04/0x05', () => {
    const bus = makeBus();
    new ImsaiSioCard().attach(bus);
    // status bytes appear at default ctrl ports
    expect(bus.ioRead(0x03) & 0x04).toBe(0x04); // TxEMPTY
    expect(bus.ioRead(0x05) & 0x04).toBe(0x04);
    // data ports exist (return 0xFF when empty queue)
    expect(bus.ioRead(0x02)).toBe(0xff);
    expect(bus.ioRead(0x04)).toBe(0xff);
  });

  it('custom ports via options override defaults', () => {
    const bus = makeBus();
    new ImsaiSioCard('sio', { basePortA: 0x10, basePortB: 0x12, boardCtrlPort: 0x18 }).attach(bus);
    expect(bus.ioRead(0x11) & 0x04).toBe(0x04); // custom ctrl A
    expect(bus.ioRead(0x13) & 0x04).toBe(0x04); // custom ctrl B
    expect(bus.ioRead(0x03)).toBe(0xff);          // old port unmapped
    expect(bus.ioRead(0x05)).toBe(0xff);
  });
});

describe('ImsaiSioCard — TX end-to-end', () => {
  it('CPU write to data port fires transmitCb', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    const received: number[] = [];
    card.channelA.onTransmit(b => received.push(b));
    bus.ioWrite(0x03, 0x4e); // mode: 8N1 ÷16
    bus.ioWrite(0x03, 0x01); // command: TxEN=1
    bus.ioWrite(0x02, 0x41); // transmit 'A'
    expect(received).toEqual([0x41]);
  });

  it('channel B TX is independent of channel A', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    const rxA: number[] = [];
    const rxB: number[] = [];
    card.channelA.onTransmit(b => rxA.push(b));
    card.channelB.onTransmit(b => rxB.push(b));
    bus.ioWrite(0x03, 0x4e); bus.ioWrite(0x03, 0x01); bus.ioWrite(0x02, 0x41); // A sends 'A'
    bus.ioWrite(0x05, 0x4e); bus.ioWrite(0x05, 0x01); bus.ioWrite(0x04, 0x42); // B sends 'B'
    expect(rxA).toEqual([0x41]);
    expect(rxB).toEqual([0x42]);
  });
});

describe('ImsaiSioCard — RX end-to-end', () => {
  it('CPU reads byte enqueued by host', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    card.channelA.enqueueRx(0x42);
    bus.ioWrite(0x03, 0x4e); // mode
    bus.ioWrite(0x03, 0x04); // command: RxE=1
    expect(bus.ioRead(0x03) & 0x02).toBe(0x02); // RxRDY
    expect(bus.ioRead(0x02)).toBe(0x42);
    expect(bus.ioRead(0x03) & 0x02).toBe(0);    // RxRDY cleared
  });
});

describe('ImsaiSioCard — board control port reset', () => {
  it('writing bits 0-1 to board ctrl resets channel A', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    bus.ioWrite(0x03, 0x4e);
    bus.ioWrite(0x03, 0x01); // TxEN=1 on A
    expect(bus.ioRead(0x03) & 0x01).toBe(1);
    bus.ioWrite(0x08, 0x01); // board ctrl: reset A
    expect(bus.ioRead(0x03) & 0x01).toBe(0); // TxRDY gone
  });

  it('writing bits 2-3 to board ctrl resets channel B', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    bus.ioWrite(0x05, 0x4e);
    bus.ioWrite(0x05, 0x01); // TxEN=1 on B
    expect(bus.ioRead(0x05) & 0x01).toBe(1);
    bus.ioWrite(0x08, 0x04); // board ctrl: reset B
    expect(bus.ioRead(0x05) & 0x01).toBe(0);
  });
});

describe('ImsaiSioCard — bus.reset() propagates', () => {
  it('bus.reset() resets both channels', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    bus.ioWrite(0x03, 0x4e); bus.ioWrite(0x03, 0x01); // A: TxEN=1
    bus.ioWrite(0x05, 0x4e); bus.ioWrite(0x05, 0x01); // B: TxEN=1
    expect(bus.ioRead(0x03) & 0x01).toBe(1);
    expect(bus.ioRead(0x05) & 0x01).toBe(1);
    bus.reset();
    expect(bus.ioRead(0x03) & 0x01).toBe(0);
    expect(bus.ioRead(0x05) & 0x01).toBe(0);
  });
});

describe('ImsaiSioCard — IMSAI initialization sequence', () => {
  it('full worst-case init sequence produces TxRDY=1', () => {
    const bus = makeBus();
    const card = new ImsaiSioCard();
    card.attach(bus);
    // Worst-case 3-byte flush + IR + mode + command (from skill doc)
    bus.ioWrite(0x03, 0x00);
    bus.ioWrite(0x03, 0x00);
    bus.ioWrite(0x03, 0x00);
    bus.ioWrite(0x03, 0x40); // Internal Reset
    bus.ioWrite(0x03, 0x4e); // Mode: 8N1 ÷16
    bus.ioWrite(0x03, 0x37); // Command: TX+RX enable, DTR, RTS, error reset
    bus.ioWrite(0x03, 0x27); // Command: same without error reset
    const status = bus.ioRead(0x03);
    expect(status & 0x01).toBe(1); // TxRDY
    expect(status & 0x04).toBe(4); // TxEMPTY
  });
});
