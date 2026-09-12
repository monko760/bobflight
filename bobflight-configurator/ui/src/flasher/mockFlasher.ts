/**
 * Mock flasher — last-resort fallback if Protocol createFlasher('mock') throws.
 * Never claims WebUSB DFU success.
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ParsedHex as ProtocolParsedHex } from "@bobflight/protocol";
import type {
  BobFlightMcu,
  FlashDeviceInfo,
  Flasher,
  FlashOptions,
  FlashProgress,
  ParsedHex,
} from "./types";
import {
  DEFAULT_FLASH_BASE,
  MCU_FLASH_SIZE,
  normalizeMcu,
  toUiParsedHex,
} from "./types";

type ProgressCb = (p: FlashProgress) => void;

function asParsed(firmware: ProtocolParsedHex | Uint8Array): ParsedHex {
  if (firmware instanceof Uint8Array) {
    return {
      bytes: firmware,
      baseAddress: DEFAULT_FLASH_BASE,
      regions: [{ address: DEFAULT_FLASH_BASE, data: firmware }],
      startAddress: DEFAULT_FLASH_BASE,
      byteLength: firmware.byteLength,
    };
  }
  if (
    typeof (firmware as ParsedHex).startAddress === "number" &&
    typeof (firmware as ParsedHex).byteLength === "number"
  ) {
    return firmware as ParsedHex;
  }
  return toUiParsedHex(firmware);
}

function gateMcu(parsed: ParsedHex, expectedMcu?: FlashOptions["expectedMcu"]): BobFlightMcu | null {
  const expected = normalizeMcu(expectedMcu);
  if (!expected) return null;

  const hint = normalizeMcu(parsed.mcuHint ?? parsed.mcu);
  if (hint && hint !== expected) {
    throw new Error(
      `MCU mismatch: hex looks like ${hint}, board expects ${expected}. Refusing flash.`,
    );
  }

  const max = MCU_FLASH_SIZE[expected];
  if (parsed.byteLength > max) {
    throw new Error(
      `Image ${parsed.byteLength} bytes exceeds ${expected} flash size (${max} bytes).`,
    );
  }
  return expected;
}

export function createMockFlasher(): Flasher {
  const listeners = new Set<ProgressCb>();
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;

  const emit = (p: FlashProgress) => {
    for (const cb of listeners) cb(p);
  };

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flasher: Flasher = {
    kind: "mock",

    async requestDevice(): Promise<FlashDeviceInfo> {
      return {
        productName: "Mock ST ROM DFU",
        vendorId: 0x0483,
        productId: 0xdf11,
        serialNumber: "MOCK-DFU",
      };
    },

    onProgress(cb: ProgressCb): () => void {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },

    cancel(): void {
      cancelled = true;
      clearTimer();
      emit({
        phase: "cancelled",
        bytesWritten: 0,
        bytesTotal: 0,
        message: "Flash cancelled",
      });
    },

    async flash(
      firmware: ProtocolParsedHex | Uint8Array,
      opts?: FlashOptions,
    ): Promise<void> {
      if (running) {
        throw new Error("Flash already in progress");
      }

      cancelled = false;
      const parsed = asParsed(firmware);
      gateMcu(parsed, opts?.expectedMcu);

      const total = parsed.byteLength;
      const verify = opts?.verify ?? false;
      const leave = opts?.leave ?? true;

      const phases: Array<{ phase: FlashProgress["phase"]; ms: number; write?: boolean }> = [
        { phase: "opening", ms: 400 },
        { phase: "erasing", ms: 700 },
        { phase: "writing", ms: 1600, write: true },
      ];
      if (verify) phases.push({ phase: "verifying", ms: 800 });
      if (leave) phases.push({ phase: "leaving", ms: 400 });

      running = (async () => {
        let written = 0;
        try {
          for (const step of phases) {
            if (cancelled) {
              emit({
                phase: "cancelled",
                bytesWritten: written,
                bytesTotal: total,
                message: "Cancelled",
              });
              throw new DOMException("Flash cancelled", "AbortError");
            }

            if (step.write) {
              const slices = 8;
              for (let i = 1; i <= slices; i++) {
                if (cancelled) {
                  emit({
                    phase: "cancelled",
                    bytesWritten: written,
                    bytesTotal: total,
                    message: "Cancelled",
                  });
                  throw new DOMException("Flash cancelled", "AbortError");
                }
                written = Math.floor((total * i) / slices);
                emit({
                  phase: "writing",
                  bytesWritten: written,
                  bytesTotal: total,
                  message: `Writing mock image… ${Math.round((100 * written) / total)}%`,
                });
                await new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, step.ms / slices);
                });
              }
            } else {
              emit({
                phase: step.phase,
                bytesWritten: written,
                bytesTotal: total,
                message:
                  step.phase === "opening"
                    ? "Opening mock DFU device…"
                    : step.phase === "erasing"
                      ? "Erasing (mock)…"
                      : step.phase === "verifying"
                        ? "Verifying (mock)…"
                        : step.phase === "leaving"
                          ? "Leaving DFU (mock)…"
                          : step.phase,
              });
              await new Promise<void>((resolve) => {
                timer = setTimeout(resolve, step.ms);
              });
            }
          }

          if (cancelled) {
            emit({
              phase: "cancelled",
              bytesWritten: written,
              bytesTotal: total,
              message: "Cancelled",
            });
            throw new DOMException("Flash cancelled", "AbortError");
          }

          emit({
            phase: "done",
            bytesWritten: total,
            bytesTotal: total,
            message:
              "MOCK ONLY — no firmware written to the board",
          });
        } catch (err) {
          if (
            cancelled ||
            (err instanceof DOMException && err.name === "AbortError")
          ) {
            throw err;
          }
          const msg = err instanceof Error ? err.message : String(err);
          emit({
            phase: "error",
            bytesWritten: written,
            bytesTotal: total,
            message: msg,
          });
          throw err;
        } finally {
          clearTimer();
          running = null;
        }
      })();

      return running;
    },
  };

  return flasher;
}
