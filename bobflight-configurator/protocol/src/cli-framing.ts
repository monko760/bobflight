/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Line-oriented USB CDC framing for BobFlight CLI.
 * FW: commands ended by LF or CR; replies use CRLF; trim leading/trailing spaces.
 */

export const DEFAULT_IDLE_MS = 40;
export const DEFAULT_TIMEOUT_MS = 2000;

/** Split incoming bytes into CRLF/LF/CR-delimited lines (without terminators). */
export class LineBuffer {
  private buf = "";

  push(chunk: string | Buffer): string[] {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.buf += text;
    const lines: string[] = [];
    // Normalize: treat \r\n, \n, and lone \r as line ends (FW replies are \r\n).
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf[i];
      if (c === "\r") {
        lines.push(this.buf.slice(0, i));
        if (i + 1 < this.buf.length && this.buf[i + 1] === "\n") {
          this.buf = this.buf.slice(i + 2);
        } else {
          this.buf = this.buf.slice(i + 1);
        }
        i = 0;
        continue;
      }
      if (c === "\n") {
        lines.push(this.buf.slice(0, i));
        this.buf = this.buf.slice(i + 1);
        i = 0;
        continue;
      }
      i++;
    }
    return lines;
  }

  /** Incomplete trailing text (no line ending yet). */
  remainder(): string {
    return this.buf;
  }

  clear(): void {
    this.buf = "";
  }
}

/** Encode a CLI command for the wire (exact name + LF). */
export function encodeCommand(cmd: string): string {
  const trimmed = cmd.trim();
  return trimmed + "\n";
}

/**
 * Collect a response until quiet for idleMs or timeout.
 * Used by sendCommand(); does not parse content.
 */
export class ResponseCollector {
  private chunks: string[] = [];
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private hardTimer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private readonly resolve: (text: string) => void;
  private readonly reject: (err: Error) => void;
  private readonly idleMs: number;
  private readonly endMarker?: string;

  constructor(
    resolve: (text: string) => void,
    reject: (err: Error) => void,
    opts: { idleMs?: number; timeoutMs?: number; endMarker?: string } = {}
  ) {
    this.resolve = resolve;
    this.reject = reject;
    this.idleMs = opts.idleMs ?? DEFAULT_IDLE_MS;
    this.endMarker = opts.endMarker;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.hardTimer = setTimeout(() => {
      this.finish(true);
    }, timeoutMs);
  }

  push(text: string): void {
    if (this.settled) return;
    this.chunks.push(text);
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.endMarker) {
      // Only sensor queries use explicit framing. Never return partial snapshots
      // merely because USB packets pause; leave all legacy/motor framing alone.
      const lines = this.chunks.join("").split(/\r\n|\n|\r/).slice(0, -1);
      if (lines.includes(this.endMarker) || (this.endMarker === "modes_end: 1" && lines.some(line => line.startsWith("mode_range refused:"))) || lines.some(line => /^unknown(?: — try help| command)?$/.test(line.trim()))) this.finish(false);
      return;
    }
    this.idleTimer = setTimeout(() => this.finish(false), this.idleMs);
  }

  private finish(fromTimeout: boolean): void {
    if (this.settled) return;
    this.settled = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    const text = this.chunks.join("");
    if (fromTimeout && (text.length === 0 || this.endMarker)) {
      this.reject(new Error(this.endMarker ? "Incomplete sensor response: terminator missing" : "CLI command timed out with empty response"));
      return;
    }
    this.resolve(text);
  }

  cancel(err?: Error): void {
    if (this.settled) return;
    this.settled = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.hardTimer) clearTimeout(this.hardTimer);
    this.reject(err ?? new Error("response cancelled"));
  }
}
