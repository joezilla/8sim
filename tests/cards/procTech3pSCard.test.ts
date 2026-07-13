import { describe, it, expect } from 'vitest';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Bus } from '../../src/bus/Bus.js';
import { ProcTech3pSCard } from '../../src/cards/ProcTech3pSCard.js';
import { ProcTech3pS, SIO2_STATUS } from '../../src/cards/ProcTech3pS.js';
import type { ProcTech3pSOptions } from '../../src/cards/ProcTech3pS.js';

function harness(opts: ProcTech3pSOptions = {}) {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const card = new ProcTech3pSCard('3ps', opts);
  card.attach(bus);
  return { bus, card, pic };
}

describe('ProcTech3pS — port mapping', () => {
  it('claims 4 consecutive ports from the base', () => {
    const dev = new ProcTech3pS('d', { baseAddress: 0x10 });
    expect(dev.basePorts).toEqual([0x10, 0x11, 0x12, 0x13]);
  });

  it('CDAB order: status/control=base+0, data=base+1, A=base+2, B=base+3', () => {
    const { bus, card } = harness({ baseAddress: 0x00, channelOrder: 'CDAB' });
    // Channel D (data) at base+1 transmits.
    let tx = -1;
    card.serial.onTransmit((b) => { tx = b; });
    bus.ioWrite(0x01, 0x5a);
    expect(tx).toBe(0x5a);
    // Channel A (parallel) at base+2 latches.
    bus.ioWrite(0x02, 0xa1);
    expect(card.portA.read()).toBe(0xa1);
    // Channel B (parallel) at base+3 latches.
    bus.ioWrite(0x03, 0xb2);
    expect(card.portB.read()).toBe(0xb2);
  });

  it('ABCD order: A=base+0, B=base+1, C=base+2, D=base+3', () => {
    const { bus, card } = harness({ channelOrder: 'ABCD' });
    bus.ioWrite(0x00, 0xaa);
    expect(card.portA.read()).toBe(0xaa);
    let tx = -1;
    card.serial.onTransmit((b) => { tx = b; });
    bus.ioWrite(0x03, 0x44); // Channel D at base+3
    expect(tx).toBe(0x44);
  });

  it('a0Invert swaps the port pairs (CDAB → data at base+0, status at base+1)', () => {
    const { bus, card } = harness({ channelOrder: 'CDAB', a0Invert: true });
    let tx = -1;
    card.serial.onTransmit((b) => { tx = b; });
    bus.ioWrite(0x00, 0x77); // with a0Invert, base+0 → Channel D (data)
    expect(tx).toBe(0x77);
    // status/control now at base+1 (a control write must not transmit)
    bus.ioWrite(0x01, 0x00);
    expect(tx).toBe(0x77);
  });
});

describe('ProcTech3pS — status word (Channel C IN)', () => {
  it('PT-native default: TBE=bit7, RDA=bit6', () => {
    const { bus, card } = harness(); // CDAB, PT-native
    expect(bus.ioRead(0x00) & 0x80).toBe(0x80); // TBE always set (instant TX)
    expect(bus.ioRead(0x00) & 0x40).toBe(0); // no RX yet
    card.serial.enqueueRx(0x41);
    expect(bus.ioRead(0x00) & 0x40).toBe(0x40); // RDA now set
  });

  it('SIO-2 preset: TBE=bit0, RDA=bit1, OE=bit4', () => {
    const { bus, card } = harness({ statusMap: SIO2_STATUS });
    expect(bus.ioRead(0x00) & 0x01).toBe(0x01); // TBE
    card.serial.enqueueRx(0x41);
    expect(bus.ioRead(0x00) & 0x02).toBe(0x02); // RDA
    card.serial.enqueueRx(0x42); // overrun (buffer still full)
    expect(bus.ioRead(0x00) & 0x10).toBe(0x10); // OE
  });

  it('reading status is non-destructive', () => {
    const { bus, card } = harness();
    card.serial.enqueueRx(0x41);
    expect(bus.ioRead(0x00) & 0x40).toBe(0x40);
    expect(bus.ioRead(0x00) & 0x40).toBe(0x40); // still there after a status read
    bus.ioRead(0x01); // reading DATA clears RDA
    expect(bus.ioRead(0x00) & 0x40).toBe(0);
  });
});

describe('ProcTech3pS — Channel D UART', () => {
  it('RX round-trip: enqueue → status RDA → IN data returns byte and clears RDA', () => {
    const { bus, card } = harness();
    card.serial.enqueueRx(0x39);
    expect(bus.ioRead(0x00) & 0x40).toBe(0x40);
    expect(bus.ioRead(0x01)).toBe(0x39); // Channel D data
    expect(bus.ioRead(0x00) & 0x40).toBe(0);
  });

  it('TX fires onTransmit and TBE stays true', () => {
    const { bus, card } = harness();
    const out: number[] = [];
    card.serial.onTransmit((b) => out.push(b));
    bus.ioWrite(0x01, 0x48);
    bus.ioWrite(0x01, 0x49);
    expect(out).toEqual([0x48, 0x49]);
    expect(bus.ioRead(0x00) & 0x80).toBe(0x80); // TBE still ready
  });
});

describe('ProcTech3pS — Channels A/B parallel + FA/FB', () => {
  it('output latch reflects CPU writes; onOutput fires', () => {
    const { bus, card } = harness();
    let last = -1;
    card.portA.onOutput((b) => { last = b; });
    bus.ioWrite(0x02, 0xcc);
    expect(card.portA.read()).toBe(0xcc);
    expect(last).toBe(0xcc);
  });

  it('pulseInput sets FA; IN clears it; plain setInput does not set FA', () => {
    const { bus, card } = harness(); // PT-native: FA unmapped by default → map it
    const mapped = new ProcTech3pSCard('m', { statusMap: { TBE: 0x80, RDA: 0x40, FA: 0x01, FB: 0x02 } });
    const b2 = new Bus(new InterruptController());
    mapped.attach(b2);
    mapped.portA.pulseInput(0x7e);
    expect(b2.ioRead(0x00) & 0x01).toBe(0x01); // FA set
    expect(b2.ioRead(0x02)).toBe(0x7e); // read Channel A
    expect(b2.ioRead(0x00) & 0x01).toBe(0); // FA cleared by the read
    mapped.portA.setInput(0x11); // no flag
    expect(b2.ioRead(0x00) & 0x01).toBe(0);
    expect(b2.ioRead(0x02)).toBe(0x11);
    void bus; void card;
  });
});

describe('ProcTech3pS — control word + config mode', () => {
  it('control write latches bits 0-3 and fires onControl', () => {
    const dev = new ProcTech3pS('d');
    let ctl = -1;
    dev.onControl((v) => { ctl = v; });
    dev.ioWrite(0x00, 0x0d); // control word
    expect(ctl).toBe(0x0d);
    expect(dev.control).toBe(0x0d & 0x0f);
  });

  it('dynamic mode reloads word format from bits 4-7; static ignores it', () => {
    const dyn = new ProcTech3pS('dyn', { configMode: 'dynamic' });
    dyn.ioWrite(0x00, 0x30); // bits4-7 = 0011 → WLS1=1,WLS2=1 → 8 data bits
    // (word format is internal; assert no crash + control nibble captured)
    expect(dyn.control).toBe(0x00);
    const stat = new ProcTech3pS('stat', { configMode: 'static' });
    stat.ioWrite(0x00, 0xf0); // static: config nibble ignored, no throw
    expect(stat.control).toBe(0x00);
  });
});

describe('ProcTech3pS — reset', () => {
  it('reset clears RDA/OE, sets TBE, clears FA/FB and latches; wiring survives', () => {
    const { bus, card } = harness({ statusMap: { TBE: 0x80, RDA: 0x40, FA: 0x01 } });
    const out: number[] = [];
    card.serial.onTransmit((b) => out.push(b));
    card.serial.enqueueRx(0x41);
    card.portA.pulseInput(0x22);
    bus.ioWrite(0x02, 0x99);
    bus.reset();
    expect(bus.ioRead(0x00) & 0x40).toBe(0); // RDA cleared
    expect(bus.ioRead(0x00) & 0x80).toBe(0x80); // TBE set
    expect(bus.ioRead(0x00) & 0x01).toBe(0); // FA cleared
    expect(card.portA.read()).toBe(0); // output latch cleared
    bus.ioWrite(0x01, 0x55); // transmit callback still wired
    expect(out).toContain(0x55);
  });
});

describe('ProcTech3pS — interrupts (opt-in)', () => {
  it('raises the configured IRQ line on RDA rising edge', () => {
    const pic = new InterruptController();
    const bus = new Bus(pic);
    const card = new ProcTech3pSCard('irq', {
      interrupts: { line: 3, sources: ['RDA'] },
      pic,
    });
    card.attach(bus);
    expect(pic.hasPendingInterrupt()).toBe(false);
    card.serial.enqueueRx(0x41);
    expect(pic.hasPendingInterrupt()).toBe(true);
    expect(pic.acknowledge()).toBe(0xc7 | (3 << 3)); // RST vector for line 3
  });

  it('polled default never asserts', () => {
    const { pic, card } = harness();
    card.serial.enqueueRx(0x41);
    expect(pic.hasPendingInterrupt()).toBe(false);
  });
});
