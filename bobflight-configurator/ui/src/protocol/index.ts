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
export { ALLOWED_CLI_COMMANDS, SETTINGS_KEYS } from "./types";
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
} from "@bobflight/protocol";
export type { ParsedGetReply, ParsedSetReply } from "@bobflight/protocol";
