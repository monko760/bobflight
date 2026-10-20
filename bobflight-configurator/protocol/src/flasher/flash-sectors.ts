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
  const match = /^\s*@Internal Flash\s*\/\s*0x08000000\s*\/\s*([^/]+)\s*$/i.exec(name ?? "");
  if (!match) throw new Error(`Cannot verify ${mcu} internal-flash layout. No erase/program issued.`);
  const actual: number[] = [];
  for (const group of match[1].split(",")) {
    const part = /^\s*(\d{1,3})\s*\*\s*(\d{1,4})\s*K\s*g\s*$/i.exec(group);
    if (!part) throw new Error("Unsupported internal-flash layout descriptor. No erase/program issued.");
    const count = Number(part[1]), size = Number(part[2]);
    if (!count || !size || actual.length + count > 12) throw new Error("Invalid internal-flash sector count.");
    for (let i = 0; i < count; i++) actual.push(size);
  }
  if (actual.join(",") !== SIZES[mcu!].join(","))
    throw new Error(`DFU geometry does not match selected ${mcu} main flash. No erase/program issued.`);
}
