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
