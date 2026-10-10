/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * MCU / image gating for ST ROM DFU flash (F745 vs F722).
 */

import { hasF405DiagnosticMarkers, validateF405DiagnosticImage } from "./f405-diagnostic";
import type { ParsedHex } from "./intel-hex";
import {
  DEFAULT_FLASH_BASE,
  MCU_FLASH_SIZE,
  type BobFlightMcu,
  type FlashOptions,
} from "./types";

function asMcu(s: string | undefined): BobFlightMcu | undefined {
  if (s === "F745" || s === "F722" || s === "F405") return s;
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
  if (opts?.expectedMcu !== undefined && !expected) {
    throw new Error(`Unsupported target MCU: ${opts.expectedMcu}. No fallback is allowed.`);
  }
  if (firmware.mcu !== undefined && !tagged) {
    throw new Error(`Unsupported firmware MCU tag: ${firmware.mcu}. No fallback is allowed.`);
  }


  if (expected && tagged && expected !== tagged) {
    throw new Error(
      `MCU gate: firmware is tagged ${tagged} but target expected ${expected}. ` +
        `Never flash F722 images on F745 (or vice versa).`
    );
  }

  if (expected === "F405" || tagged === "F405" || opts?.imageProfile !== undefined || hasF405DiagnosticMarkers(firmware)) {
    if (expected !== "F405" || opts?.imageProfile !== "f405-usb-diagnostic") throw new Error("F405 diagnostic requires its explicit profile and expected MCU; no fallback is allowed.");
    if (opts.verify === false || opts.leave !== false) throw new Error("F405 diagnostic requires readback verification and leave=false for a cold power-cycle.");
    if (opts.startAddress !== undefined && opts.startAddress !== DEFAULT_FLASH_BASE) throw new Error("F405 diagnostic requires application base 0x08000000.");
    validateF405DiagnosticImage(firmware);
  }

  if (opts?.eraseMode === "full-chip") {
    if (!expected || opts.verify === false) throw new Error("Full chip erase requires an explicit supported MCU and readback verification.");
    // Full erase destroys even sectors outside the image. Validate the actual
    // application vectors and programmed bytes before any USB write, not only
    // UI selection or a filename. F405 has its stricter diagnostic gate above.
    if (expected !== "F405") {
      if (firmware.baseAddress !== DEFAULT_FLASH_BASE || firmware.bytes.length < 8 || !firmware.regions.length)
        throw new Error("Full chip erase requires an application vector table at 0x08000000.");
      let previous = DEFAULT_FLASH_BASE;
      for (const r of [...firmware.regions].sort((a,b) => a.address-b.address)) {
        const end = r.address + r.data.length;
        if (!Number.isSafeInteger(r.address) || !Number.isSafeInteger(end) || !r.data.length ||
            r.address < previous || end > DEFAULT_FLASH_BASE + MCU_FLASH_SIZE[expected] ||
            end > DEFAULT_FLASH_BASE + firmware.bytes.length)
          throw new Error("Full erase application ranges overlap, are empty, or exceed selected flash.");
        for (let i = 0; i < r.data.length; i++)
          if (r.data[i] !== firmware.bytes[r.address - DEFAULT_FLASH_BASE + i])
            throw new Error("Full erase application bytes disagree with programmed regions.");
        previous = end;
      }
      const mapped = (address: number) => firmware.regions.some(r => address >= r.address && address < r.address + r.data.length);
      for (let i=0;i<8;i++) if (!mapped(DEFAULT_FLASH_BASE+i)) throw new Error("Full erase application vectors contain missing bytes.");
      const vectors = new DataView(firmware.bytes.buffer,firmware.bytes.byteOffset,firmware.bytes.byteLength);
      const stack = vectors.getUint32(0,true), reset = vectors.getUint32(4,true);
      if (stack !== 0x20010000 || !(reset & 1) || !mapped((reset & ~1) >>> 0))
        throw new Error("Full erase requires valid BobFlight F7 stack and mapped Thumb reset vectors.");
      if (firmware.entryAddress !== undefined && (!Number.isSafeInteger(firmware.entryAddress) || !mapped((firmware.entryAddress & ~1) >>> 0)))
        throw new Error("Full erase entry address is outside programmed application data.");
    }
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
