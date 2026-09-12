/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @bobflight/protocol — host↔FC USB CDC CLI transport (Path B: no MSP).
 */

export type {
  PortInfo,
  ConnectionStatus,
  CliCommand,
  ConnectOptions,
  SendCommandOptions,
  ParsedStatus,
  ReconnectOptions,
} from "./types";

export {
  BobFlightCliClient,
  enumeratePorts,
} from "./client";

export { parseStatus, parseVersionLine } from "./parse-status";
export {
  LineBuffer,
  ResponseCollector,
  encodeCommand,
  DEFAULT_IDLE_MS,
  DEFAULT_TIMEOUT_MS,
} from "./cli-framing";
export type { SerialPortLike, TransportFactory } from "./transport";
export { DEFAULT_BAUD_RATE } from "./transport";
export {
  MockSerial,
  MOCK_PORT_PATH,
} from "./mock-serial";
export type { MockSerialOptions } from "./mock-serial";
export {
  AutoTransportFactory,
  MockTransportFactory,
  SerialportTransportFactory,
  isSerialportAvailable,
  serialportUnavailableReason,
} from "./serial-backend";

export {
  SETTINGS_KEYS,
  DEFAULT_SETTINGS,
  DEFAULT_SETTING_VALUES,
  cloneDefaultSettings,
  cloneDefaultSettingValues,
  formatFwFloat,
  validateSettingValue,
  parseCliFloat,
  isSettingsKey,
  parseGetReply,
  parseSetReply,
  parseSaveReply,
  parseDefaultsReply,
} from "./settings";
export type {
  SettingsKey,
  ParsedGetReply,
  ParsedSetReply,
} from "./settings";

export {
  WebSerialTransportFactory,
  WebSerialPort,
  isWebSerialAvailable,
  webSerialUnavailableReason,
  pathForWebSerialPort,
} from "./web-serial";
export type {
  WebSerialPortNative,
  WebSerialRequestPortOptions,
} from "./web-serial";

// --- Firmware flasher (ST ROM USB DFU / WebUSB; separate from CDC CLI) ---
export type {
  FlashPhase,
  FlashProgress,
  FlashOptions,
  Flasher,
  FlashDeviceInfo,
  BobFlightMcu,
} from "./flasher/types";
export {
  FLASH_CAPABILITIES,
  BOARD_MCU,
  MCU_FLASH_SIZE,
  DEFAULT_FLASH_BASE,
} from "./flasher/types";
export type { ParsedHex, HexRegion } from "./flasher/intel-hex";
export {
  parseIntelHex,
  loadHexFromUint8Array,
} from "./flasher/intel-hex";
export { MockFlasher } from "./flasher/mock-flasher";
export {
  WebUsbDfuFlasher,
  isWebUsbAvailable,
  webUsbUnavailableReason,
  ST_DFU_VID,
  ST_DFU_PID,
  DEFAULT_ALT,
} from "./flasher/webusb-dfu";
export type { FlasherBackend, FirmwareFileLike, ParseFirmwareOptions } from "./flasher/session";
export {
  createFlasher,
  parseFirmware,
  BobFlightFlasher,
} from "./flasher/session";
export { assertMcuGate, normalizeFirmware } from "./flasher/mcu-gate";
