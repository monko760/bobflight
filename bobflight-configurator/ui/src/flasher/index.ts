/**
 * UI flasher adapter — @bobflight/protocol createFlasher / parseIntelHex / WebUSB.
 * SPDX-License-Identifier: Apache-2.0
 */

export type {
  FlashPhase,
  FlashProgress,
  BobFlightMcu,
  ExpectedMcu,
  ParsedHex,
  FlashOptions,
  FlashDeviceInfo,
  Flasher,
  BoardId,
} from "./types";

export {
  FLASH_CAPABILITIES,
  BOARD_MCU,
  MCU_FLASH_SIZE,
  DEFAULT_FLASH_BASE,
  BOARD_OPTIONS,
  normalizeMcu,
  mcuDisplayName,
} from "./types";

export { parseIntelHex, mcuHintFromFilename, IntelHexError } from "./intelHex";
export { createMockFlasher } from "./mockFlasher";
export {
  createFlasher,
  isWebUsbAvailable,
  webUsbUnavailableReason,
  protocolFlasherReady,
  type FlasherKind,
} from "./createFlasher";
export { tryBindProtocolFlasher } from "./protocolBridge";
