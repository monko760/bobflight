/**
 * Firmware flasher types — Protocol shapes + UI board helpers.
 * SPDX-License-Identifier: Apache-2.0
 */

export type {
  FlashPhase,
  FlashProgress,
  FlashOptions,
  Flasher,
  FlashDeviceInfo,
  BobFlightMcu,
  HexRegion,
} from "@bobflight/protocol";

export {
  FLASH_CAPABILITIES,
  BOARD_MCU,
  MCU_FLASH_SIZE,
  DEFAULT_FLASH_BASE,
} from "@bobflight/protocol";

import type {
  BobFlightMcu,
  ParsedHex as ProtocolParsedHex,
} from "@bobflight/protocol";

/** Accept protocol short form or STM32* display form. */
export type ExpectedMcu = BobFlightMcu | "STM32F745" | "STM32F722" | string;

/**
 * UI ParsedHex: Protocol fields (for flash()) plus FlasherPage display aliases.
 */
export interface ParsedHex extends ProtocolParsedHex {
  /** Alias of baseAddress for FlasherPage. */
  startAddress: number;
  byteLength: number;
  /** Alias / filename hint; also mirrored to `mcu` for Protocol gating. */
  mcuHint?: string;
}

export const BOARD_OPTIONS = [
  {
    boardId: "kakute_f7_hdv",
    label: "Kakute F7 HDV",
    mcu: "F745" as BobFlightMcu,
    mcuDisplay: "STM32F745",
    primary: true,
  },
  {
    boardId: "tmotor_f7_v2",
    label: "T-Motor F7 V2",
    mcu: "F722" as BobFlightMcu,
    mcuDisplay: "STM32F722",
    primary: false,
  },
] as const;

export type BoardId = (typeof BOARD_OPTIONS)[number]["boardId"];

export function normalizeMcu(mcu: ExpectedMcu | undefined): BobFlightMcu | null {
  if (!mcu) return null;
  const s = String(mcu).toUpperCase().replace(/^STM32/, "");
  if (s === "F745" || s.includes("F745")) return "F745";
  if (s === "F722" || s.includes("F722")) return "F722";
  return null;
}

export function mcuDisplayName(mcu: BobFlightMcu): string {
  return mcu === "F745" ? "STM32F745" : "STM32F722";
}

/** Build UI ParsedHex from Protocol parse result. */
export function toUiParsedHex(
  proto: ProtocolParsedHex,
  mcuHint?: string,
): ParsedHex {
  const mcu = mcuHint ?? proto.mcu;
  return {
    ...proto,
    mcu,
    startAddress: proto.baseAddress,
    byteLength: proto.bytes.byteLength,
    mcuHint: mcu,
  };
}
