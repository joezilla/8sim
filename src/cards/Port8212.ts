import type { IIODevice } from '../interfaces/IIODevice.js';
import { u8 } from '../util/bits.js';

type PortWriteCallback = (value: number) => void;

/**
 * Intel / AMD 8212 eight-bit latched I/O port, as used for the IMSAI MIO
 * board's two parallel ports. A CPU write latches the output byte (held on the
 * output pins); a CPU read returns whatever is currently presented on the input
 * pins. Output and input are independent, modelling a bidirectional 8212 port.
 *
 * The host drives the input pins with {@link setInput} and observes the latched
 * output via {@link output} or an {@link onWrite} callback — this is how a
 * printer, LED bank, switch bank, or other peripheral is wired to the port.
 */
export class Port8212 implements IIODevice {
  readonly id: string;
  readonly basePorts: ReadonlyArray<number>;

  private outputLatch = 0;
  private inputLatch = 0xff; // unconnected TTL inputs float high
  private writeCb: PortWriteCallback | undefined;

  constructor(id: string, port: number) {
    this.id = id;
    this.basePorts = [port];
  }

  ioRead(_port: number): number {
    return this.inputLatch;
  }

  ioWrite(_port: number, value: number): void {
    this.outputLatch = u8(value);
    this.writeCb?.(this.outputLatch);
  }

  reset(): void {
    this.outputLatch = 0;
    this.inputLatch = 0xff;
    // writeCb survives reset — it is host wiring.
  }

  /** Drive the port's input pins — the value the CPU reads from this port. */
  setInput(value: number): void {
    this.inputLatch = u8(value);
  }

  /** The byte currently latched on the output pins. */
  get output(): number {
    return this.outputLatch;
  }

  /** Register a callback fired whenever the CPU writes the output latch. */
  onWrite(cb: PortWriteCallback): void {
    this.writeCb = cb;
  }
}
