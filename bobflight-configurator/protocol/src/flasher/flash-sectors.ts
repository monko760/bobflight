import type { HexRegion } from "./intel-hex";
import { DEFAULT_FLASH_BASE } from "./types";

// ST RM0385 (F745) and RM0431 (F722), main flash sector sizes in KiB.
const SIZES: Record<string, readonly number[]> = {
  F745: [32, 32, 32, 32, 128, 256, 256, 256],
  F722: [16, 16, 16, 16, 64, 128, 128, 128],
};

/** Validate all ranges before USB writes; erase each intersecting sector once. */
export function planSectorErases(regions: readonly HexRegion[], mcu: string | undefined): number[] {
  const sizes = mcu === "F745" || mcu === "F722" ? SIZES[mcu] : undefined;
  if (!sizes) throw new Error("Select a supported target (F745 or F722) before flashing.");
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
