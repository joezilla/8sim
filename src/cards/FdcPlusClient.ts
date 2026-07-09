export interface WebSocketLike {
  send(data: Uint8Array): void;
  close(): void;
  onmessage: ((ev: { data: ArrayBuffer | Uint8Array }) => void) | null;
  onclose:   (() => void) | null;
  onerror:   ((err: unknown) => void) | null;
  readonly readyState: number; // 0=CONNECTING 1=OPEN 2=CLOSING 3=CLOSED
}

type PendingEntry = {
  resolve: (data: Uint8Array) => void;
  reject:  (err: Error) => void;
  bytesExpected: number;
};

export class FdcPlusClient {
  private rxBuf:   Uint8Array[] = [];
  private rxTotal  = 0;
  private pending: PendingEntry[] = [];

  constructor(private readonly ws: WebSocketLike) {
    ws.onmessage = (ev) => {
      const chunk = ev.data instanceof ArrayBuffer
        ? new Uint8Array(ev.data)
        : ev.data;
      this.rxBuf.push(chunk);
      this.rxTotal += chunk.length;
      this.drain();
    };
    ws.onerror = () => this.rejectAll(new Error('WebSocket error'));
    ws.onclose = () => this.rejectAll(new Error('WebSocket closed'));
  }

  stat(drive: number, headLoad: boolean, track: number): Promise<number> {
    const p1 = ((headLoad ? 1 : 0) << 8) | (drive & 0xff);
    this.ws.send(this.makeCmd('STAT', p1, track & 0xffff));
    return this.enqueue(8).then(buf => this.parseCmd(buf).p2);
  }

  readTrack(drive: number, track: number, length: number): Promise<Uint8Array> {
    const p1 = ((drive & 0xf) << 12) | (track & 0xfff);
    this.ws.send(this.makeCmd('READ', p1, length));
    return this.enqueue(length);
  }

  writeTrack(drive: number, track: number, data: Uint8Array): Promise<void> {
    const p1 = ((drive & 0xf) << 12) | (track & 0xfff);
    this.ws.send(this.makeCmd('WRIT', p1, data.length));
    return this.enqueue(8).then(ackBuf => {
      const ack = this.parseCmd(ackBuf);
      if (ack.p1 !== 0) throw new Error(`WRIT rejected: status ${ack.p1}`);
      this.ws.send(data);
      return this.enqueue(8).then(wstaBuf => {
        const wsta = this.parseCmd(wstaBuf);
        if (wsta.p1 !== 0) throw new Error(`WSTA error: status ${wsta.p1}`);
      });
    });
  }

  private makeCmd(mnemonic: string, p1: number, p2: number): Uint8Array {
    const buf = new Uint8Array(8);
    for (let i = 0; i < 4; i++) buf[i] = mnemonic.charCodeAt(i) & 0xff;
    buf[4] = p1 & 0xff;
    buf[5] = (p1 >> 8) & 0xff;
    buf[6] = p2 & 0xff;
    buf[7] = (p2 >> 8) & 0xff;
    return buf;
  }

  private parseCmd(buf: Uint8Array): { cmd: string; p1: number; p2: number } {
    const cmd = String.fromCharCode(
      buf[0] ?? 0, buf[1] ?? 0, buf[2] ?? 0, buf[3] ?? 0,
    );
    const p1 = (buf[4] ?? 0) | ((buf[5] ?? 0) << 8);
    const p2 = (buf[6] ?? 0) | ((buf[7] ?? 0) << 8);
    return { cmd, p1, p2 };
  }

  private enqueue(bytesExpected: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject, bytesExpected });
      this.drain();
    });
  }

  private drain(): void {
    while (this.pending.length > 0) {
      const head = this.pending[0];
      if (!head || this.rxTotal < head.bytesExpected) break;
      this.pending.shift();
      head.resolve(this.collect(head.bytesExpected));
    }
  }

  private collect(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let written = 0;
    while (written < n) {
      const chunk = this.rxBuf[0];
      if (!chunk) break;
      const needed = n - written;
      if (chunk.length <= needed) {
        out.set(chunk, written);
        written += chunk.length;
        this.rxBuf.shift();
        this.rxTotal -= chunk.length;
      } else {
        out.set(chunk.subarray(0, needed), written);
        this.rxBuf[0] = chunk.subarray(needed);
        this.rxTotal -= needed;
        written = n;
      }
    }
    return out;
  }

  private rejectAll(err: Error): void {
    const entries = this.pending.splice(0);
    for (const e of entries) e.reject(err);
  }
}
