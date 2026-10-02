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
  MotorPulsePercent,
  ConnectOptions,
  SendCommandOptions,
  ParsedStatus,
  ReconnectOptions,
} from "./types";

export {
  BobFlightCliClient,
  enumeratePorts,
  isR0bDshotCliCommand,
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
export {
  MockOnboardBlackbox,
  MOCK_BLACKBOX_UNAVAILABLE,
  formatOnboardStatus,
  formatOnboardStatusV1,
  formatDropPct,
} from "./blackbox-mock";
export type { MockBlackboxCard, OnboardStatusFields } from "./blackbox-mock";
export type { MockSerialOptions, DshotTelemStatus } from "./mock-serial";
export { DSHOT_TELEM_STATUSES } from "./mock-serial";
export {
  AutoTransportFactory,
  MockTransportFactory,
  SerialportTransportFactory,
  isSerialportAvailable,
  serialportUnavailableReason,
} from "./serial-backend";

export {
  SETTINGS_KEYS,
  SCHEMA5_FLOAT_KEYS,
  SCHEMA6_FLOAT_KEYS,
  SCHEMA8_FLOAT_KEYS,
  SCHEMA9_INT_KEYS,
  isOptionalSettingsKey,
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
  Schema5FloatKey,
  Schema6FloatKey,
  Schema8FloatKey,
  Schema9IntKey,
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

/** Offline motor command simulator; not a hardware controller. */
export { MockMotorBench } from "./bench-mock";

export { mockSensorReply } from "./sensor-mock";
export { MockReceiver } from "./receiver-mock";

export * from "./parse-ports";
export * from "./parse-modes";
export { MockPortsModes } from "./ports-modes-mock";

export * from "./storage";

export * from "./loop-rate";
export * from "./loop-rate-mock";
export * from "./loop-rate-setting";

export {
  GYRO_NOTCH_KEYS, GYRO_NOTCH_INDEXES, GYRO_NOTCH_UNKNOWN, GYRO_NOTCH_REASONS,
  notchCenterKey, notchCutoffKey, isGyroNotchKey, isGyroNotchCliCommand,
  validateNotchCenter, validateNotchCutoffAlone, notchPairProblem, notchWritePlan,
  parseNotchGetReply, parseNotchSetReply, parseFiltersReport, notchRowView,
} from "./gyro-notch";
export type { GyroNotchKey, GyroNotchIndex, NotchPair, NotchGetResult, NotchSetResult, NotchReport, FiltersReport, FiltersReportResult, NotchRowView } from "./gyro-notch";
export { MockGyroNotch, GYRO_NOTCH_MOCK_SCENARIOS } from "./gyro-notch-mock";
export type { GyroNotchMockScenario } from "./gyro-notch-mock";

export {
  RPM_FILTER_KEYS, RPM_FILTER_MOTORS, RPM_FILTER_UNKNOWN, RPM_FILTER_REASONS,
  isRpmFilterKey, isRpmFilterCliCommand, rpmValueProblem, qFromX100, qToX100,
  parseRpmGetReply, parseRpmSetReply, parseRpmFilterReport, rpmFilterView, RPM_FILTER_REPORT_FIELDS, rpmFilterReportIsExact,
} from "./rpm-filter";
export type { RpmFilterKey, RpmFilterMotor, RpmGetResult, RpmSetResult, RpmFilterReport, RpmFilterReportResult, RpmFilterView } from "./rpm-filter";
export { MockRpmFilter, RPM_FILTER_MOCK_SCENARIOS } from "./rpm-filter-mock";
export type { RpmFilterMockScenario } from "./rpm-filter-mock";
