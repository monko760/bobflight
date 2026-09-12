/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * MCU / image gating for ST ROM DFU flash (F745 vs F722).
 */

import type { ParsedHex } from "./intel-hex";
import {
  DEFAULT_FLASH_BASE,
  MCU_FLASH_SIZE,
  type BobFlightMcu,
  type FlashOptions,
} from "./types";

function asMcu(s: string | undefined): BobFlightMcu | undefined {
  if (s === "F745" || s === "F722") return s;
  return undefined;
}

/**
 * Refuse mismatched MCU tags and images that overrun the expected MCU flash.
 * NEVER allow an F722-tagged hex onto an F745 target (or the reverse).
 */
export function assertMcuGate(
  firmware: ParsedHex,
  opts?: FlashOptions
): void {
  const expected = asMcu(opts?.expectedMcu);
  const tagged = asMcu(firmware.mcu);

  if (expected && tagged && expected !== tagged) {
    throw new Error(
      `MCU gate: firmware is tagged ${tagged} but target expected ${expected}. ` +
        `Never flash F722 images on F745 (or vice versa).`
    );
  }

  const mcu = expected ?? tagged;
  if (!mcu) return;

  const flashSize = MCU_FLASH_SIZE[mcu];
  const base = opts?.startAddress ?? DEFAULT_FLASH_BASE;
  // Prefer absolute region ends; fall back to contiguous buffer.
  let end = base;
  if (firmware.regions.length > 0) {
    for (const r of firmware.regions) {
      const rEnd = r.address + r.data.length;
      if (rEnd > end) end = rEnd;
    }
  } else {
    end = firmware.baseAddress + firmware.bytes.length;
  }

  const limit = base + flashSize;
  if (end > limit) {
    throw new Error(
      `MCU gate: image ends at 0x${end.toString(16)} which exceeds ${mcu} ` +
        `flash (base 0x${base.toString(16)}, size ${flashSize} bytes).`
    );
  }
}

/** Normalize ParsedHex | Uint8Array into ParsedHex (raw bin → single region). */
export function normalizeFirmware(
  firmware: ParsedHex | Uint8Array,
  startAddress: number
): ParsedHex {
  if (firmware instanceof Uint8Array) {
    return {
      baseAddress: startAddress,
      bytes: firmware,
      regions: [{ address: startAddress, data: firmware }],
    };
  }
  return firmware;
}
