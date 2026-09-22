import { MockPortsModes, isModeRangeCommand, isControlSourceCommand } from "@bobflight/protocol";
/**
 * Browser-safe mock host matching BobFlightCliClient surface.
 * Same FW CLI contract as Protocol MockSerial (banner, status keys,
 * arm refuse, reboot disconnect) without Node deps.
 *
 * Primary path is ProtocolHostAdapter + MockTransportFactory; this host
 * remains for legacy smoke / offline UI experiments.
 */

import {
  SETTINGS_KEYS,
  MockMotorBench,
  mockSensorReply,
  cloneDefaultSettings,
  type SettingsKey,
} from "@bobflight/protocol";
import type {
  BobFlightHost,
  CliCommand,
  ConnectOptions,
  ConnectionStatus,
  ParsedStatus,
  PortInfo,
} from "./types";
import { ALLOWED_CLI_COMMANDS } from "./types";
import { parseStatus, parseVersionLine } from "./parseStatus";

const MOCK_BANNER = "BobFlight 0.1.0-skeleton ready";
const ARM_REFUSE = "arm refused (gyro unhealthy or failsafe)";

const MOCK_PORTS: PortInfo[] = [
  {
    path: "mock://bobflight",
    manufacturer: "BobFlight",
    friendlyName: "BobFlight Mock CDC",
    serialNumber: "MOCK-001",
  },
  {
    path: "mock://bobflight-alt",
    manufacturer: "BobFlight",
    friendlyName: "BobFlight Mock CDC (alt)",
    serialNumber: "MOCK-002",
  },
];

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class MockBobFlightHost implements BobFlightHost {
  private status: ConnectionStatus = "disconnected";
  private lastError: string | null = null;
  private lineListeners = new Set<(line: string) => void>();
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private dshotBidir = false;
  private armed = false;
  private bench = new MockMotorBench();
  private gyroHealthy = false;
  private failsafeActive = false;
  private connectDelayMs: number;
  private settings: Record<SettingsKey, string> = cloneDefaultSettings();

  constructor(opts?: { connectDelayMs?: number; gyroHealthy?: boolean }) {
    this.connectDelayMs = opts?.connectDelayMs ?? 180;
    this.gyroHealthy = opts?.gyroHealthy ?? false;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getConnectionStatus(): ConnectionStatus {
    return this.status;
  }

  onLine(cb: (line: string) => void): () => void {
    this.lineListeners.add(cb);
    return () => {
      this.lineListeners.delete(cb);
    };
  }

  onStatus(cb: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.status);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  private setStatus(s: ConnectionStatus): void {
    if (this.status === s) return;
    if(s==="disconnected")this.modesPorts.reset();
    this.status = s;
    for (const cb of this.statusListeners) {
      try {
        cb(s);
      } catch {
        /* ignore */
      }
    }
  }

  private emitLine(line: string): void {
    for (const cb of this.lineListeners) {
      try {
        cb(line);
      } catch {
        /* ignore */
      }
    }
  }

  private requireConnected(): void {
    if (this.status !== "connected") {
      throw new Error("not connected");
    }
  }

  async enumeratePorts(): Promise<PortInfo[]> {
    return [...MOCK_PORTS];
  }

  async requestPort(): Promise<PortInfo> {
    throw new Error(
      "Web Serial requestPort is not available on MockBobFlightHost",
    );
  }

  async connect(options: ConnectOptions): Promise<void> {
    if (this.status === "connected") {
      await this.disconnect();
    }
    this.lastError = null;
    this.armed = false;
    this.dshotBidir = false;
    this.bench.reset();
    this.setStatus("connecting");
    await delay(this.connectDelayMs);
    if (!options.path) {
      this.lastError = "No port selected";
      this.setStatus("error");
      throw new Error(this.lastError);
    }
    this.setStatus("connected");
    // SAFETY: never auto-arm — banner only.
    void delay(10).then(() => {
      if (this.status === "connected") this.emitLine(MOCK_BANNER);
    });
  }

  async disconnect(): Promise<void> {
    this.setStatus("disconnected");
    this.bench.disconnect();
    this.armed = false;
    this.dshotBidir = false;
  }

  async sendCommand(cmd: CliCommand): Promise<string> {
    if (/[\r\n]/.test(cmd)) throw new Error(`unsupported CLI command: ${String(cmd)}`);
    if (!isModeRangeCommand(cmd) && !isControlSourceCommand(cmd) && !ALLOWED_CLI_COMMANDS.includes(cmd) && !/^(receiver|receiver_map (?:AETR|TAER)|receiver_uart [123467]|motor_test [0-4]|motor_pulse [1-4] (?:[0-9]|[1-9][0-9]|100)|motor_seq|dshot(?: (?:300|600))?)$/.test(cmd) && !/^(get erpm_m[1-4]|get dshot_telem_m[1-4]|get dshot_bidir|set dshot_bidir (?:on|off))$/.test(cmd)) {
      throw new Error(`unsupported CLI command: ${String(cmd)}`);
    }
    if (this.status !== "connected") {
      throw new Error("not connected");
    }
    this.emitLine(`> ${cmd}`);
    const response = this.handle(cmd);
    for (const line of response.split(/\r?\n/)) {
      if (line.length) this.emitLine(line);
    }
    if (cmd === "reboot") {
      await delay(30);
      await this.disconnect();
    }
    return response;
  }

  async getVersion(): Promise<string> {
    const raw = await this.sendCommand("version");
    return parseVersionLine(raw);
  }

  async getStatus(): Promise<ParsedStatus> {
    const raw = await this.sendCommand("status");
    return parseStatus(raw);
  }

  async getSetting(
    key: SettingsKey,
  ): Promise<{ key: SettingsKey; value: string }> {
    this.requireConnected();
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new Error("unknown key");
    }
    return { key, value: this.settings[key] };
  }

  async setSetting(
    key: SettingsKey,
    value: string,
  ): Promise<{ key: SettingsKey; value: string }> {
    this.requireConnected();
    if (!(SETTINGS_KEYS as readonly string[]).includes(key)) {
      throw new Error("unknown key");
    }
    if (!Number.isFinite(Number(value))) {
      throw new Error("set failed");
    }
    this.settings[key] = value;
    return { key, value: this.settings[key] };
  }

  async saveSettings(): Promise<void> { throw new Error("Demo/RAM settings are not stored on a controller"); }

  async restoreDefaults(): Promise<Record<SettingsKey, string>> {
    this.requireConnected();
    this.settings = cloneDefaultSettings();
    return { ...this.settings };
  }

  async getAllSettings(): Promise<Record<SettingsKey, string>> {
    this.requireConnected();
    return { ...this.settings };
  }

  private modesPorts = new MockPortsModes();
  private receiver = new MockReceiver();
  private handle(cmd: CliCommand): string {
    // R0c: M1–M4 first-class (FW PR #52). Same wire as protocol MockSerial.
    {
      const erpm = /^get erpm_m([1-4])$/.exec(cmd);
      if (erpm) {
        const m = Number(erpm[1]);
        const st = this.r0cTelemStatus(m as 1 | 2 | 3 | 4);
        if (st === "ok") {
          const fixtures: Record<number, number> = { 1: 24600, 2: 24700, 3: 24800, 4: 24900 };
          return `erpm_m${m}=${fixtures[m]}\r\n`;
        }
        return `erpm_m${m}=none\r\n`;
      }
      const telem = /^get dshot_telem_m([1-4])$/.exec(cmd);
      if (telem) {
        return `${this.r0cTelemStatus(Number(telem[1]) as 1 | 2 | 3 | 4)}\r\n`;
      }
    }
    if (cmd === "get dshot_bidir") {
      return this.dshotBidir ? "dshot_bidir=on\r\n" : "dshot_bidir=off\r\n";
    }
    if (cmd === "set dshot_bidir on") {
      this.dshotBidir = true;
      return "ok dshot_bidir=on\r\n";
    }
    if (cmd === "set dshot_bidir off") {
      this.dshotBidir = false;
      return "ok dshot_bidir=off\r\n";
    }
    if(cmd === "bl" || cmd === "bl discard") return "bl unavailable: mock transport has no ROM bootloader\r\n";
    const pm=this.modesPorts.handle(cmd,this.armed,this.bench.active);if(pm!==null)return pm;
    if(cmd === "pid_diag" || cmd.startsWith("pid_diag "))return "pid_diag_available: no\r\nreason: mock-no-hardware\r\nmotor_output: disabled\r\npid_diag_end: 1\r\n";
    if(cmd === "blackbox start" || cmd === "blackbox stop" || cmd === "blackbox status")return "blackbox unavailable: mock has no physical SD card\r\nblackbox_end: 1\r\n";
    if(cmd.startsWith("sd read"))return "sd_data_error: unavailable-mock\r\nsd_data_end: 1\r\n";
    if(cmd === "sd probe" || cmd === "sd status" || cmd === "sd cancel")return "sd_state: unavailable-mock\r\nsd_write_enabled: no\r\nsd_end: 1\r\n";
    if(cmd === "timing")return "timing_available: no\r\ntimebase: mock-no-hardware\r\ntiming_end: 1\r\n";
    const sensorReply = mockSensorReply(cmd, this.armed);
    if (sensorReply !== null) return sensorReply;
    if(cmd==="reboot") this.receiver.reset();
    const receiverReply=this.receiver.handle(cmd,this.armed,this.bench.active);
    if(receiverReply!==null)return receiverReply;
    const benchReply = this.bench.handle(cmd, this.armed);
    if (benchReply !== null) return benchReply;
    switch (cmd) {
      case "help":
        return [
          "BobFlight CLI",
          this.bench.help,
          "  help     - this text",
          "  version  - firmware version",
          "  status   - MCU, loops, arm, gyro, board",
          "  arm      - attempt arm (refuses if gyro unhealthy)",
          "  disarm   - disarm",
          "  reboot   - soft reset (host: exit loop flag)",
        ].join("\r\n");
      case "version":
        return "BobFlight 0.1.0-skeleton";
      case "status": {
        const gyroOk = this.gyroHealthy ? "yes" : "no";
        const arm = this.armed ? "armed" : "disarmed";
        const failsafe = this.failsafeActive ? "ACTIVE" : "ok";
        return [
          "board: mock-board",
          "ir: dummy",
          "mcu: mock hse_mhz=8",
          `gyro_ok: ${gyroOk}`,
          "gyro_bind: mock",
          "dshot_bound: 0/4",
          "motor_output: unavailable",
          "rx: none unbound",
          "mmio: denied",
          `arm: ${arm}`,
          `failsafe: ${failsafe}`,
          "loop: gyro=0 Hz denom=1 cascade=0 bg=0",
        ].join("\r\n");
      }
      case "arm":
        if (this.gyroHealthy && !this.failsafeActive) {
          this.armed = true;
          return "armed";
        }
        return ARM_REFUSE;
      case "disarm":
        this.armed = false;
        return "disarmed";
      case "reboot":
        this.armed = false;
        return "reboot...";
      default:
        return "unknown — try help";
    }
  }

  /** Match protocol MockSerial default fixtures when bidir on. */
  private r0cTelemStatus(motor: 1 | 2 | 3 | 4): "ok" | "crc_fail" | "invalid" | "timeout" | "stale" | "none" {
    if (!this.dshotBidir) return "none";
    const defaults: Record<1 | 2 | 3 | 4, "ok" | "crc_fail" | "invalid" | "timeout"> = {
      1: "ok",
      2: "crc_fail",
      3: "invalid",
      4: "timeout",
    };
    return defaults[motor];
  }

  setMockGates(opts: {
    gyroHealthy?: boolean;
    failsafeActive?: boolean;
  }): void {
    if (opts.gyroHealthy !== undefined) this.gyroHealthy = opts.gyroHealthy;
    if (opts.failsafeActive !== undefined) {
      this.failsafeActive = opts.failsafeActive;
    }
  }
}

import { MockReceiver } from "@bobflight/protocol";
