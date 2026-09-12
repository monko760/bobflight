/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * BobFlightFlasher facade — createFlasher + parseFirmware helpers.
 * Separate from CDC CLI / Web Serial modules.
 */

import { parseIntelHex, type ParsedHex } from "./intel-hex";
import { MockFlasher } from "./mock-flasher";
import type { BobFlightMcu, Flasher } from "./types";
import { WebUsbDfuFlasher } from "./webusb-dfu";

export type FlasherBackend = "mock" | "webusb-dfu";

/** Minimal browser File shape (no DOM lib required for Node tsc). */
export interface FirmwareFileLike {
  readonly name: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** Factory for flash backends (mock for CI; webusb-dfu for Chrome/Edge + DFU). */
export function createFlasher(backend: FlasherBackend): Flasher {
  switch (backend) {
    case "mock":
      return new MockFlasher();
    case "webusb-dfu":
      return new WebUsbDfuFlasher();
    default: {
      const _exhaustive: never = backend;
      throw new Error(`unknown flasher backend: ${String(_exhaustive)}`);
    }
  }
}

export interface ParseFirmwareOptions {
  /** Tag the image for MCU gating (F745 / F722). */
  mcu?: BobFlightMcu | string;
}

/**
 * Load firmware for the UI: File-like, HEX string, or bytes.
 * .hex / text → Intel HEX parse; otherwise treated as raw binary (caller
 * must supply startAddress via FlashOptions).
 */
export async function parseFirmware(
  file: FirmwareFileLike | string | Uint8Array,
  opts?: ParseFirmwareOptions
): Promise<ParsedHex> {
  let parsed: ParsedHex;

  if (typeof file === "string") {
    const trimmed = file.trimStart();
    if (trimmed.startsWith(":")) {
      parsed = parseIntelHex(file);
    } else {
      const enc =
        typeof TextEncoder !== "undefined"
          ? new TextEncoder().encode(file)
          : new Uint8Array(Buffer.from(file, "utf8"));
      parsed = {
        baseAddress: 0,
        bytes: enc,
        regions: [{ address: 0, data: enc }],
      };
    }
  } else if (isFileLike(file)) {
    const buf = new Uint8Array(await file.arrayBuffer());
    const name = file.name.toLowerCase();
    if (name.endsWith(".hex") || looksLikeIntelHex(buf)) {
      parsed = parseIntelHex(buf);
    } else {
      parsed = {
        baseAddress: 0,
        bytes: buf,
        regions: [{ address: 0, data: buf }],
      };
    }
  } else {
    const buf = file;
    if (looksLikeIntelHex(buf)) {
      parsed = parseIntelHex(buf);
    } else {
      parsed = {
        baseAddress: 0,
        bytes: buf,
        regions: [{ address: 0, data: buf }],
      };
    }
  }

  if (opts?.mcu) {
    parsed.mcu = opts.mcu;
  }
  return parsed;
}

function isFileLike(v: unknown): v is FirmwareFileLike {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as FirmwareFileLike).arrayBuffer === "function" &&
    typeof (v as FirmwareFileLike).name === "string"
  );
}

function looksLikeIntelHex(data: Uint8Array): boolean {
  for (let i = 0; i < Math.min(data.length, 64); i++) {
    const c = data[i];
    if (c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a) continue;
    return c === 0x3a; // ':'
  }
  return false;
}

/** Convenience facade name used by UI docs. */
export const BobFlightFlasher = {
  createFlasher,
  parseFirmware,
};
