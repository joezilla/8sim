export interface IBus {
  read(address: number): number;
  write(address: number, value: number): void;
  ioRead(port: number): number;
  ioWrite(port: number, value: number): void;
  acknowledgeInterrupt(): number;
}
