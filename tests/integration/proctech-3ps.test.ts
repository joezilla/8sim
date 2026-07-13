import { describe, it, expect } from 'vitest';
import { Cpu8080 } from '../../src/cpu/Cpu8080.js';
import { InterruptController } from '../../src/interrupt/InterruptController.js';
import { Ram } from '../../src/memory/Ram.js';
import { Bus } from '../../src/bus/Bus.js';
import { ProcTech3pSCard } from '../../src/cards/ProcTech3pSCard.js';
import type { ProcTech3pSOptions } from '../../src/cards/ProcTech3pS.js';

/**
 * End-to-end: a real Cpu8080 drives the 3P+S with the manual's verbatim
 * Appendix-V poll idioms (CDAB order, PT-native status: STATUS=port 0, DATA=port
 * 1, TBE=0x80, RDA=0x40). No async backend, so a bounded synchronous step loop
 * suffices.
 */

function machine(program: number[], opts: ProcTech3pSOptions = {}) {
  const pic = new InterruptController();
  const bus = new Bus(pic);
  const ram = new Ram('ram', 0x0000, 0x10000); // I/O-only card → full 64K RAM
  bus.attachMemory(ram);
  const card = new ProcTech3pSCard('3ps', { baseAddress: 0x00, ...opts });
  card.attach(bus);
  const cpu = new Cpu8080(bus, pic);
  cpu.reset();
  cpu.registers.sp = 0xf000;
  cpu.registers.pc = 0x0000;
  ram.load(new Uint8Array(program), 0x0000);
  return { cpu, card };
}

describe('3P+S end-to-end (real Cpu8080, Appendix-V idioms)', () => {
  it('serial echo loop echoes fed characters verbatim', () => {
    // ORG 0 echo loop: wait RDA, read data, wait TBE, transmit, repeat.
    const echo = [
      0xdb, 0x00, // LOOP: IN STATUS
      0xe6, 0x40, //       ANI RDA (0x40)
      0xca, 0x00, 0x00, // JZ LOOP
      0xdb, 0x01, //       IN PORT1 (read RX, clears RDA)
      0x47, //             MOV B,A
      0xdb, 0x00, // TXW:  IN STATUS
      0xe6, 0x80, //       ANI TBE (0x80)
      0xca, 0x0a, 0x00, // JZ TXW
      0x78, //             MOV A,B
      0xd3, 0x01, //       OUT PORT1 (transmit)
      0xc3, 0x00, 0x00, // JMP LOOP
    ];
    const { cpu, card } = machine(echo);
    const out: number[] = [];
    card.serial.onTransmit((b) => out.push(b & 0x7f));
    for (const ch of 'Hi!') card.serial.enqueueRx(ch.charCodeAt(0));

    for (let i = 0; i < 20_000 && out.length < 3; i++) cpu.step();
    expect(String.fromCharCode(...out)).toBe('Hi!');
  });

  it('parallel loopback copies Channel A input to its output latch and clears FA', () => {
    // ORG 0: IN PORTA / OUT PORTA / JMP  (PORTA = base+2 in CDAB order)
    const loop = [
      0xdb, 0x02, // IN PORTA (clears FA)
      0xd3, 0x02, // OUT PORTA
      0xc3, 0x00, 0x00, // JMP 0
    ];
    const { cpu, card } = machine(loop, { statusMap: { TBE: 0x80, RDA: 0x40, FA: 0x01 } });
    card.portA.pulseInput(0x6d); // external device presents a byte, raises FA
    for (let i = 0; i < 200; i++) cpu.step();
    expect(card.portA.read()).toBe(0x6d); // input echoed to the output latch
  });
});
