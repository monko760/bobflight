export type {
  BobFlightHost,
  CliCommand,
  ConnectOptions,
  ConnectionStatus,
  ParsedStatus,
  PortInfo,
  SettingsKey,
  WebSerialRequestPortOptions,
} from "./types";
export { ALLOWED_CLI_COMMANDS, SETTINGS_KEYS, parseCliInput, isBootloaderCommand } from "./types";
export { parseStatus, parseVersionLine, shouldDisableArm } from "./parseStatus";
export { MockBobFlightHost } from "./mockHost";
export {
  createHost,
  getDefaultBaudRates,
  MOCK_PORT_PATH,
  resolveConnectOptions,
  isWebSerialAvailable,
  webSerialUnavailableReason,
} from "./createHost";
export type { ProtocolMode } from "./createHost";
export {
  parseGetReply,
  parseSetReply,
  parseSaveReply,
  parseDefaultsReply,
  isSettingsKey,
  DEFAULT_SETTINGS,
  SCHEMA5_FLOAT_KEYS,
  isR0bDshotCliCommand,
} from "@bobflight/protocol";
export type { ParsedGetReply, ParsedSetReply, Schema5FloatKey } from "@bobflight/protocol";

export { parsePorts, parseModes, modeRangeCommand, isModeRangeCommand, controlSourceCommand, isControlSourceCommand, controlModeCommand, isControlModeCommand, canEditModeRanges, canSelectControlSource, canSelectControlMode } from "@bobflight/protocol";
export type { ParsedPorts, ParsedModes, ModeRow } from "@bobflight/protocol";

export {parseStorage,parseConfigurationExport,canSaveStorage} from "@bobflight/protocol";
export type {StorageSnapshot} from "@bobflight/protocol";

export { parseLoopStatus, loopRateView, LOOP_LABELS, LOOP_STATUS_KEYS, LOOP_UNKNOWN, mockLoopStatusLines, LOOP_RATE_MOCK_SCENARIOS } from "@bobflight/protocol";
export type { LoopStatus, LoopRateView, LoopRateItem, LoopRateMockScenario } from "@bobflight/protocol";
export { LOOP_RATE_SETTING_KEY, LOOP_RATE_OPTIONS, LOOP_RATE_OPTION_LABELS, LOOP_RATE_SETTING_UNKNOWN, isLoopRateOption, loopRateSetCommand, parseLoopRateGetReply, parseLoopRateSetReply, parseLoopRateReport, loopRateSettingView } from "@bobflight/protocol";
export type { LoopRateOption, LoopRateGetResult, LoopRateSetResult, LoopRateReport, LoopRateSettingView } from "@bobflight/protocol";
export { GYRO_NOTCH_KEYS, GYRO_NOTCH_INDEXES, GYRO_NOTCH_UNKNOWN, notchCenterKey, notchCutoffKey, isGyroNotchKey, notchPairProblem, notchWritePlan, parseNotchGetReply, parseFiltersReport, notchRowView, GYRO_NOTCH_MOCK_SCENARIOS } from "@bobflight/protocol";
export type { GyroNotchKey, GyroNotchIndex, NotchPair, NotchGetResult, FiltersReportResult, NotchRowView, GyroNotchMockScenario } from "@bobflight/protocol";
