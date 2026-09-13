/**
 * Re-export protocol types; keep BobFlightHost + ALLOWED_CLI_COMMANDS for UI.
 */
export type {
  PortInfo,
  ConnectionStatus,
  CliCommand,
  MotorPulsePercent,
  ConnectOptions,
  ParsedStatus,
  SettingsKey,
} from "@bobflight/protocol";

export type { WebSerialRequestPortOptions } from "@bobflight/protocol";

export { SETTINGS_KEYS } from "@bobflight/protocol";

import type { CliCommand } from "@bobflight/protocol";
import type {
  ConnectOptions,
  ConnectionStatus,
  ParsedStatus,
  PortInfo,
  SettingsKey,
  WebSerialRequestPortOptions,
} from "@bobflight/protocol";

export const ALLOWED_CLI_COMMANDS: readonly CliCommand[] = [
  "help", "ports", "modes", "storage", "save", "diff all", "dump all",
  "version",
  "pid_diag", "pid_diag status", "pid_diag start", "pid_diag start rx", "pid_diag stop",
  "timing", "status", "sensors", "calibration", "calibration_cancel", "calibrate_gyro",
  "calibrate_accel start", "calibrate_accel apply", "calibrate_accel cancel",
  "calibrate_accel +x", "calibrate_accel -x", "calibrate_accel +y",
  "calibrate_accel -y", "calibrate_accel +z", "calibrate_accel -z",
  "arm",
  "bench_switch",
  "bench_stop",
  "bench_status",
  "receiver",
  "disarm",
  "reboot", "bl", "bl discard",
] as const;

/** Exact single-line UI input; preserve complete arguments, never just a verb. */
export function parseCliInput(raw: string): CliCommand | null {
  if (/[\x00-\x1f\x7f]/.test(raw)) return null; // reject multiline/control injection
  const cmd = raw.trim().toLowerCase().replace(/ +/g, " ");
  // Preserve the existing explicit bench command spelling restriction.
  if ((cmd === "bench_switch" || cmd === "bench_stop") && raw.trim() !== cmd) return null;
  return (ALLOWED_CLI_COMMANDS as readonly string[]).includes(cmd) ? cmd as CliCommand : null;
}

export function isBootloaderCommand(cmd: CliCommand): boolean {
  return cmd === "bl" || cmd === "bl discard";
}

/** Thin host surface — mirrors BobFlightCliClient for screens. */
export interface BobFlightHost {
  enumeratePorts(): Promise<PortInfo[]>;
  /** Browser user-gesture: navigator.serial.requestPort via Protocol. */
  requestWebSerialPort?(opts?: {
    filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
  }): Promise<PortInfo>;
  connect(options: ConnectOptions): Promise<void>;
  disconnect(): Promise<void>;
  sendCommand(cmd: CliCommand): Promise<string>;
  getVersion(): Promise<string>;
  getStatus(): Promise<ParsedStatus>;
  getConnectionStatus(): ConnectionStatus;
  onLine(cb: (line: string) => void): () => void;
  onStatus(cb: (s: ConnectionStatus) => void): () => void;
  getLastError(): string | null;

  /**
   * Chrome/Edge Web Serial picker (user gesture). Registers port and returns
   * PortInfo with a `webserial:` path. Not available on mock-only hosts.
   */
  requestPort(opts?: WebSerialRequestPortOptions): Promise<PortInfo>;

  /** Optional: refresh already-granted Web Serial ports via getPorts(). */
  refreshWebSerialPorts?(): Promise<PortInfo[]>;

  /** Settings — mirrors BobFlightCliClient (FW-locked first-12 keys). */
  getSetting(key: SettingsKey): Promise<{ key: SettingsKey; value: string }>;
  setSetting(
    key: SettingsKey,
    value: string,
  ): Promise<{ key: SettingsKey; value: string }>;
  saveSettings(): Promise<void>;
  restoreDefaults(): Promise<Record<SettingsKey, string>>;
  getAllSettings(): Promise<Record<SettingsKey, string>>;
}
