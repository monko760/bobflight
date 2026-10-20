import type { HexRegion } from "./intel-hex";
import { DEFAULT_FLASH_BASE } from "./types";

// ST RM0385 (F745) and RM0431 (F722), main flash sector sizes in KiB.
const SIZES: Record<string, readonly number[]> = {
  F405: [16, 16, 16, 16, 64, 128, 128, 128, 128, 128, 128, 128],
  F745: [32, 32, 32, 32, 128, 256, 256, 256],
  F722: [16, 16, 16, 16, 64, 128, 128, 128],
};

/** Validate all ranges before USB writes; erase each intersecting sector once. */
export function planSectorErases(regions: readonly HexRegion[], mcu: string | undefined): number[] {
  const sizes = mcu === "F745" || mcu === "F722" || mcu === "F405" ? SIZES[mcu] : undefined;
  if (!sizes) throw new Error("Select a supported target (F745, F722 or explicit F405 diagnostic) before flashing.");
  let address = DEFAULT_FLASH_BASE;
  const sectors = sizes.map(kib => {
    const start = address;
    address += kib * 1024;
    return { start, end: address };
  });
  const selected = new Set<number>();
  for (const r of regions) {
    const end = r.address + r.data.length;
    if (!Number.isSafeInteger(r.address) || r.address < DEFAULT_FLASH_BASE ||
        !Number.isSafeInteger(end) || end > address || r.data.length === 0) {
      throw new Error(`Invalid firmware range at 0x${r.address.toString(16)} for ${mcu} main flash.`);
    }
    for (const s of sectors) {
      if (r.address < s.end && end > s.start) selected.add(s.start);
    }
  }
  return [...selected].sort((a, b) => a - b);
}

export interface DfuFlashLayout { base: number; sectors: { start: number; end: number }[]; totalBytes: number; sizesKiB: number[]; }

/**
 * Parse the DfuSe internal-flash descriptor (alt 0 interface string), e.g.
 * `@Internal Flash /0x08000000/04*032Kg,01*128Kg,03*256Kg`. Any other shape is refused.
 */
export function parseDfuFlashLayout(name: string | null | undefined): DfuFlashLayout {
  if (name == null || name.trim() === "") throw new Error("DFU flash-layout descriptor missing: cannot verify the device flash size. No erase/program issued.");
  const match = /^\s*@Internal Flash\s*\/\s*0x08000000\s*\/\s*([^/]+?)\s*$/i.exec(name);
  if (!match) throw new Error(`DFU flash-layout descriptor not understood: "${name}". No erase/program issued.`);
  const sizesKiB: number[] = [];
  for (const group of match[1].split(",")) {
    const part = /^\s*(\d{1,3})\s*\*\s*(\d{1,4})\s*K\s*g\s*$/i.exec(group);
    if (!part) throw new Error(`DFU flash-layout descriptor not understood: "${name}". No erase/program issued.`);
    const count = Number(part[1]), size = Number(part[2]);
    if (!count || !size || sizesKiB.length + count > 64) throw new Error(`DFU flash-layout descriptor has an invalid sector count: "${name}". No erase/program issued.`);
    for (let i = 0; i < count; i++) sizesKiB.push(size);
  }
  let address = DEFAULT_FLASH_BASE;
  const sectors = sizesKiB.map(kib => { const start = address; address += kib * 1024; return { start, end: address }; });
  return { base: DEFAULT_FLASH_BASE, sectors, totalBytes: address - DEFAULT_FLASH_BASE, sizesKiB };
}

/** Erase plan from the device's own layout; refuses if any region does not fit that flash. */
export function planSectorErasesFromLayout(regions: readonly HexRegion[], layout: DfuFlashLayout): number[] {
  const limit = layout.base + layout.totalBytes;
  const selected = new Set<number>();
  for (const r of regions) {
    const end = r.address + r.data.length;
    if (!Number.isSafeInteger(r.address) || r.address < layout.base || !Number.isSafeInteger(end) || end > limit || r.data.length === 0) {
      throw new Error(`Firmware does not fit this device: image ends at 0x${end.toString(16)} but DFU reports ${layout.totalBytes / 1024} KiB of flash (ends 0x${limit.toString(16)}). No erase/program issued.`);
    }
    for (const s of layout.sectors) if (r.address < s.end && end > s.start) selected.add(s.start);
  }
  return [...selected].sort((a, b) => a - b);
}

/** Every main-flash sector, including settings outside the firmware image. */
export function planFullChipErases(mcu: string | undefined): number[] {
  if (mcu !== "F405" && mcu !== "F722" && mcu !== "F745")
    throw new Error("Full chip erase requires a supported, explicitly selected MCU.");
  let address = DEFAULT_FLASH_BASE;
  return SIZES[mcu].map(kib => { const start = address; address += kib * 1024; return start; });
}

/** Exact selected internal-flash geometry, not an inference from USB VID/PID.
 * Alternate zero only. OTP, option bytes and external storage are never selected. */
export function assertMainFlashLayout(name: string | null | undefined, mcu: string | undefined): void {
  planFullChipErases(mcu); // also rejects an unknown target
  const layout = parseDfuFlashLayout(name); // the one shared descriptor parser; refuses missing/malformed
  if (layout.sizesKiB.join(",") !== SIZES[mcu!].join(","))
    throw new Error(`DFU geometry does not match selected ${mcu} main flash. No erase/program issued.`);
}
