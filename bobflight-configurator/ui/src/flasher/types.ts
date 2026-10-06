import { catalog, mcuForBoard } from "../targets/catalog";
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

export const BOARD_OPTIONS = catalog.boards.flatMap(board => {
  const target = mcuForBoard(board.id);
  const mcu = normalizeMcu(target?.part);
  if (board.support === 'host-only' || target?.status !== 'implemented' || !mcu) return [];
  return [{boardId: board.id, label: board.display_name, mcu, mcuDisplay: target.part, primary: false}];
});
export type BoardId = string;

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
