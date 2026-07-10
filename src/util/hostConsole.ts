/**
 * Best-effort write to the host process's stdout — a no-op outside Node
 * (browsers, workers). Accessed via globalThis so src/ stays free of direct
 * Node built-ins per the browser-portability rule.
 */
type ProcessLike = { stdout?: { write(chunk: string): unknown } };

export function writeHostStdout(text: string): void {
  (globalThis as { process?: ProcessLike }).process?.stdout?.write(text);
}
