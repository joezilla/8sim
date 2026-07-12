/**
 * The host-side surface a video card exposes (Bitsby8 Story 5.9) — the display
 * counterpart to a serial card's `.channel` or a parallel card's `.gpio`. The
 * host reads a frame each refresh and renders it per the descriptor's mode:
 *  - `charGrid` — a character display (VDM-1): a text grid rendered via a font.
 *  - `bitmap`   — a packed pixel buffer (Dazzler): unpacked per pixel format.
 * The bytes come from the machine's memory (read via the bus), so what the CPU
 * writes to video RAM shows on screen.
 */

export type DisplayDescriptor =
  | { readonly mode: 'charGrid'; readonly cols: number; readonly rows: number; readonly font: string; readonly attrBit: number }
  | { readonly mode: 'bitmap'; readonly width: number; readonly height: number; readonly format: string };

export interface DisplayFrame {
  /** The current source bytes (a character buffer, or a packed pixel buffer). */
  readonly bytes: Uint8Array;
  /** Dynamic per-frame state (e.g. VDM scroll line, Dazzler on/format). */
  readonly state: Record<string, number>;
}

export interface DisplaySurface {
  readonly descriptor: DisplayDescriptor;
  frame(): DisplayFrame;
}
