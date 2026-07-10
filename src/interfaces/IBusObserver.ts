export interface IBusObserver {
  onMemRead?(address: number, value: number): void;
  onMemWrite?(address: number, value: number): void;
  onIoRead?(port: number, value: number): void;
  onIoWrite?(port: number, value: number): void;
}
