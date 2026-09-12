/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * In-process mock flasher for CI / smoke (no USB).
 */

import type { ParsedHex } from "./intel-hex";
import { assertMcuGate, normalizeFirmware } from "./mcu-gate";
import {
  DEFAULT_FLASH_BASE,
  type FlashDeviceInfo,
  type FlashOptions,
  type FlashProgress,
  type Flasher,
} from "./types";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic mock: erase → write (chunked) → optional verify → leave → done.
 * Cancel is checked between write chunks.
 */
export class MockFlasher implements Flasher {
  readonly kind = "mock" as const;
  private cancelled = false;
  private listeners = new Set<(p: FlashProgress) => void>();
  private chunkBytes: number;
  private tickMs: number;

  constructor(opts?: { chunkBytes?: number; tickMs?: number }) {
    this.chunkBytes = opts?.chunkBytes ?? 256;
    this.tickMs = opts?.tickMs ?? 5;
  }

  onProgress(cb: (p: FlashProgress) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  cancel(): void {
    this.cancelled = true;
  }

  async requestDevice(): Promise<FlashDeviceInfo> {
    return {
      productName: "Mock ST DFU [MOCK — no USB]",
      vendorId: 0x0483,
      productId: 0xdf11,
      serialNumber: "MOCK-DFU-001",
    };
  }

  private mockMsg(msg: string): string {
    const tag = "[MOCK — no USB]";
    return msg.startsWith(tag) ? msg : `${tag} ${msg}`;
  }

  private emit(p: FlashProgress): void {
    const tagged: FlashProgress = {
      ...p,
      message: this.mockMsg(p.message ?? p.phase),
    };
    for (const cb of this.listeners) {
      try {
        cb(tagged);
      } catch {
        /* listener errors must not break flash */
      }
    }
  }

  private throwIfCancelled(bytesWritten: number, bytesTotal: number): void {
    if (this.cancelled) {
      this.emit({
        phase: "cancelled",
        bytesWritten,
        bytesTotal,
        message: "cancelled",
      });
      throw new Error("flash cancelled");
    }
  }

  async flash(
    firmware: ParsedHex | Uint8Array,
    opts?: FlashOptions
  ): Promise<void> {
    this.cancelled = false;
    const startAddress = opts?.startAddress ?? DEFAULT_FLASH_BASE;
    const leave = opts?.leave !== false;
    const verify = opts?.verify === true;
    const parsed = normalizeFirmware(firmware, startAddress);

    try {
      assertMcuGate(parsed, opts);
    } catch (err) {
      this.emit({
        phase: "error",
        bytesWritten: 0,
        bytesTotal: 0,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const total =
      parsed.regions.length > 0
        ? parsed.regions.reduce((n, r) => n + r.data.length, 0)
        : parsed.bytes.length;

    this.emit({
      phase: "opening",
      bytesWritten: 0,
      bytesTotal: total,
      message: "[MOCK — no USB] open",
    });
    await delay(this.tickMs);
    this.throwIfCancelled(0, total);

    this.emit({
      phase: "erasing",
      bytesWritten: 0,
      bytesTotal: total,
      message: "[MOCK — no USB] erase",
    });
    await delay(this.tickMs);
    this.throwIfCancelled(0, total);

    let written = 0;
    const payload =
      parsed.regions.length > 0
        ? parsed.regions
        : [{ address: parsed.baseAddress, data: parsed.bytes }];

    for (const region of payload) {
      let off = 0;
      while (off < region.data.length) {
        this.throwIfCancelled(written, total);
        const n = Math.min(this.chunkBytes, region.data.length - off);
        off += n;
        written += n;
        this.emit({
          phase: "writing",
          bytesWritten: written,
          bytesTotal: total,
          message: `[MOCK — no USB] write @ 0x${(region.address + off - n)
            .toString(16)}`,
        });
        await delay(this.tickMs);
      }
    }

    this.throwIfCancelled(written, total);

    if (verify) {
      this.emit({
        phase: "verifying",
        bytesWritten: written,
        bytesTotal: total,
        message: "[MOCK — no USB] verify",
      });
      await delay(this.tickMs);
      this.throwIfCancelled(written, total);
    }

    if (leave) {
      this.emit({
        phase: "leaving",
        bytesWritten: written,
        bytesTotal: total,
        message: "[MOCK — no USB] leave DFU",
      });
      await delay(this.tickMs);
      this.throwIfCancelled(written, total);
    }

    this.emit({
      phase: "done",
      bytesWritten: written,
      bytesTotal: total,
      message: "[MOCK — no USB] MOCK ONLY — no firmware written to the board",
    });
  }
}
