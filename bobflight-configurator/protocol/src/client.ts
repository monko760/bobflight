import {parseStorage,isVerifiedFlashSave} from "./storage";
import { isModeRangeCommand, isControlSourceCommand } from "./parse-modes";
/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CliCommand,
  ConnectOptions,
  ConnectionStatus,
  ParsedStatus,
  PortInfo,
  ReconnectOptions,
  SendCommandOptions,
} from "./types";
import {
  DEFAULT_IDLE_MS,
  DEFAULT_TIMEOUT_MS,
  LineBuffer,
  ResponseCollector,
  encodeCommand,
} from "./cli-framing";
import { parseStatus, parseVersionLine } from "./parse-status";
import type { SerialPortLike, TransportFactory } from "./transport";
import { DEFAULT_BAUD_RATE } from "./transport";
import { AutoTransportFactory } from "./serial-backend";
import { MOCK_PORT_PATH } from "./mock-serial";
import {
  SETTINGS_KEYS,
  isSettingsKey,
  parseDefaultsReply,
  parseGetReply,
  parseSetReply,
  type SettingsKey,
} from "./settings";

const ALLOWED_COMMANDS: readonly CliCommand[] = [
  "help", "ports", "modes", "storage", "save", "diff all", "dump all",
  "version",
  "status",
  "receiver",
  "receiver_map AETR",
  "receiver_map TAER",
  "timing",
  "power",
  "arm", "bench_switch", "bench_stop",
  "disarm",
  "reboot",
  "calibrate_gyro", "sensors", "calibration", "calibration_cancel",
  "calibrate_accel start", "calibrate_accel apply", "calibrate_accel cancel",
  "calibrate_accel +x", "calibrate_accel -x", "calibrate_accel +y",
  "calibrate_accel -y", "calibrate_accel +z", "calibrate_accel -z",
  "motor_seq",
  "dshot",
  "dshot 300",
  "dshot 600",
] as const;

/**
 * Host-side BobFlight CLI client (USB CDC / serial, line-oriented).
 *
 * Safety: connect() never sends `arm`. Arm/disarm/reboot are explicit
 * API calls for UI-confirmed actions only.
 */
export class BobFlightCliClient {
  private transportFactory: TransportFactory;
  private port: SerialPortLike | null = null;
  private status: ConnectionStatus = "disconnected";
  private lineBuf = new LineBuffer();
  private collector: ResponseCollector | null = null;
  private lineListeners = new Set<(line: string) => void>();
  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private lastConnect: ConnectOptions | null = null;
  private reconnectOpts: ReconnectOptions = {
    enabled: false,
    maxAttempts: 3,
    delayMs: 500,
  };
  private reconnectAttempt = 0;
  private intentionalClose = false;
  private dataHandler: ((chunk: Buffer) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private errorHandler: ((err: Error) => void) | null = null;
  /** Commands written this session (smoke asserts no auto-arm). */
  private readonly sentCommands: string[] = [];

  constructor(transportFactory?: TransportFactory) {
    this.transportFactory = transportFactory ?? new AutoTransportFactory();
  }

  /** Commands sent since last connect (or construct). For tests/smoke. */
  getSentCommands(): readonly string[] {
    return this.sentCommands;
  }

  clearSentCommands(): void {
    this.sentCommands.length = 0;
  }

  configureReconnect(opts: ReconnectOptions): void {
    this.reconnectOpts = { ...this.reconnectOpts, ...opts };
  }

  async enumeratePorts(): Promise<PortInfo[]> {
    return this.transportFactory.enumerate();
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
    this.status = s;
    for (const cb of this.statusListeners) {
      try {
        cb(s);
      } catch {
        /* listener errors must not break transport */
      }
    }
  }

  /**
   * Open serial / mock. Does NOT send arm (or any command except listening
   * for the FW connect banner).
   */
  async connect(options: ConnectOptions): Promise<void> {
    if (this.port?.isOpen) {
      await this.disconnect();
    }
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.clearSentCommands();
    this.lastConnect = { ...options };
    this.setStatus("connecting");

    const path =
      options.transport === "mock"
        ? options.path || MOCK_PORT_PATH
        : options.path;
    const baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;

    try {
      this.port = await this.transportFactory.open({ path, baudRate });
      this.attachPort(this.port);
      this.setStatus("connected");
      // SAFETY: never auto-arm on connect. Banner arrives async from FW/mock.
    } catch (err) {
      this.setStatus("error");
      this.port = null;
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.intentionalClose = true;
    if (this.collector) {
      this.collector.cancel(new Error("disconnected"));
      this.collector = null;
    }
    const p = this.port;
    this.port = null;
    this.detachPort(p);
    if (p?.isOpen) {
      await p.close();
    }
    this.lineBuf.clear();
    this.setStatus("disconnected");
  }

  private attachPort(port: SerialPortLike): void {
    this.dataHandler = (chunk: Buffer) => this.onData(chunk);
    this.closeHandler = () => {
      void this.onPortClosed();
    };
    this.errorHandler = () => {
      this.setStatus("error");
    };
    port.on("data", this.dataHandler);
    port.on("close", this.closeHandler);
    port.on("error", this.errorHandler);
  }

  private detachPort(port: SerialPortLike | null): void {
    if (!port) return;
    const off = port.removeListener?.bind(port) ?? port.off?.bind(port);
    if (off && this.dataHandler) off("data", this.dataHandler);
    if (off && this.closeHandler) off("close", this.closeHandler);
    if (off && this.errorHandler) off("error", this.errorHandler);
    this.dataHandler = null;
    this.closeHandler = null;
    this.errorHandler = null;
  }

  private onData(chunk: Buffer): void {
    const text = chunk.toString("utf8");
    if (this.collector) {
      this.collector.push(text);
    }
    const lines = this.lineBuf.push(text);
    for (const line of lines) {
      for (const cb of this.lineListeners) {
        try {
          cb(line);
        } catch {
          /* ignore */
        }
      }
    }
  }

  private async onPortClosed(): Promise<void> {
    this.detachPort(this.port);
    this.port = null;
    if (this.collector) {
      this.collector.cancel(new Error("port closed"));
      this.collector = null;
    }
    if (this.intentionalClose) {
      this.setStatus("disconnected");
      return;
    }
    if (
      this.reconnectOpts.enabled &&
      this.lastConnect &&
      this.reconnectAttempt < (this.reconnectOpts.maxAttempts ?? 3)
    ) {
      this.setStatus("reconnecting");
      this.reconnectAttempt++;
      const delay = this.reconnectOpts.delayMs ?? 500;
      await new Promise((r) => setTimeout(r, delay));
      if (this.intentionalClose || !this.lastConnect) return;
      try {
        await this.connect(this.lastConnect);
      } catch {
        this.setStatus("error");
      }
      return;
    }
    this.setStatus("disconnected");
  }

  /**
   * Send an exact CLI command and collect the full response until idle/timeout.
   * Exact allowlisted commands only; motor starts are explicit, never retried.
   */
  async sendCommand(
    cmd: CliCommand,
    opts?: SendCommandOptions
  ): Promise<string> {
    if (!isModeRangeCommand(cmd) && !isControlSourceCommand(cmd) && !ALLOWED_COMMANDS.includes(cmd) && !/^(receiver_uart [123467]|motor_test [0-4]|motor_pulse [1-4] (?:[0-9]|[12][0-9]|3[0-5]))$/.test(cmd) && !/^power_config(?: [0-9]+(?:\.[0-9]+)?){7}$/.test(cmd)) {
      throw new Error(`unsupported CLI command: ${String(cmd)}`);
    }
    return this.sendRaw(cmd, opts);
  }

  /**
   * Send a free-form CLI line (settings get/set/save/defaults, etc.).
   * Does not widen CliCommand; dedicated settings methods prefer this.
   */
  async sendRaw(line: string, opts?: SendCommandOptions): Promise<string> {
    if (!this.port?.isOpen || this.status !== "connected") {
      throw new Error("not connected");
    }
    if (this.collector) {
      throw new Error("another command is in flight");
    }

    const idleMs = opts?.idleMs ?? DEFAULT_IDLE_MS;
    const timeoutMs = opts?.timeoutMs ?? (line === "save" ? 15000 : DEFAULT_TIMEOUT_MS);

    const responsePromise = new Promise<string>((resolve, reject) => {
      this.collector = new ResponseCollector(
        (text) => {
          this.collector = null;
          resolve(text);
        },
        (err) => {
          this.collector = null;
          // A truncated framed snapshot can leave late USB bytes in flight.
          // Reconnect rather than risk attributing them to a later command.
          if (line === "save" || ((line === "storage" || line === "diff all" || line === "dump all" || line === "sensors" || line === "calibration" || line === "timing" || line === "ports" || line === "modes" || (line.startsWith("mode_range ") || line.startsWith("control_source "))) && /terminator missing/.test(err.message))) void this.disconnect();
          reject(err);
        },
        { idleMs, timeoutMs,
          endMarker: line === "storage" ? "storage_end: 1" : (line === "diff all" || line === "dump all") ? "# config_end: 1" : line === "ports" ? "ports_end: 1" : (line === "modes" || (line.startsWith("mode_range ") || line.startsWith("control_source "))) ? "modes_end: 1" : line === "timing" ? "timing_end: 1" : line === "sensors" ? "sensors_end: 1" : line === "calibration" ? "calibration_end: 1" : undefined }
      );
    });

    const wireCmd = line.trim();
    this.sentCommands.push(wireCmd);
    const wire = encodeCommand(wireCmd);
    this.port.write(wire);

    return responsePromise;
  }

  async getVersion(opts?: SendCommandOptions): Promise<string> {
    const raw = await this.sendCommand("version", opts);
    return parseVersionLine(raw);
  }

  async getStatus(opts?: SendCommandOptions): Promise<ParsedStatus> {
    const raw = await this.sendCommand("status", opts);
    return parseStatus(raw);
  }

  /** UI-confirmed arm only — never called from connect(). */
  async arm(opts?: SendCommandOptions): Promise<string> {
    return this.sendCommand("arm", opts);
  }

  async disarm(opts?: SendCommandOptions): Promise<string> {
    return this.sendCommand("disarm", opts);
  }

  async reboot(opts?: SendCommandOptions): Promise<string> {
    return this.sendCommand("reboot", opts);
  }

  // --- Settings (FW-locked first-12 keys) ---

  async getSetting(
    key: SettingsKey,
    opts?: SendCommandOptions
  ): Promise<{ key: SettingsKey; value: string }> {
    if (!isSettingsKey(key)) {
      throw new Error(`unsupported settings key: ${String(key)}`);
    }
    const raw = await this.sendRaw(`get ${key}`, opts);
    const parsed = parseGetReply(raw);
    if (!parsed.ok || parsed.key !== key || parsed.value === undefined) {
      throw new Error(
        `get ${key} failed: ${JSON.stringify(raw.trim())}`
      );
    }
    return { key, value: parsed.value };
  }

  async setSetting(
    key: SettingsKey,
    value: string,
    opts?: SendCommandOptions
  ): Promise<{ key: SettingsKey; value: string }> {
    if (!isSettingsKey(key)) {
      throw new Error(`unsupported settings key: ${String(key)}`);
    }
    const raw = await this.sendRaw(`set ${key} ${value}`, opts);
    const parsed = parseSetReply(raw);
    if (!parsed.ok || parsed.key !== key || parsed.value === undefined) {
      throw new Error(
        `set ${key} failed: ${JSON.stringify(raw.trim())}`
      );
    }
    return { key, value: parsed.value };
  }

  async saveSettings(opts?: SendCommandOptions): Promise<void> {
    const before=parseStorage(await this.sendCommand("storage",opts));
    if(before.backend!=="flash"||before.armed||before.benchActive||before.calibrationActive||before.flightEnabled)throw new Error("Controller flash save unavailable: disarm and stop bench motors; mock/RAM save is not durable");
    const raw=await this.sendRaw("save",opts);
    if(!isVerifiedFlashSave(raw))throw new Error(`Save was not verified: ${raw.trim()}`);
    const after=parseStorage(await this.sendCommand("storage",opts));
    if(after.backend!=="flash"||after.dirty||after.state!=="saved")throw new Error("Post-save verification failed");
  }

  /**
   * Restore FW defaults (does not auto-save). Returns all 12 keys after reset.
   */
  async restoreDefaults(
    opts?: SendCommandOptions
  ): Promise<Record<SettingsKey, string>> {
    const raw = await this.sendRaw("defaults", opts);
    const parsed = parseDefaultsReply(raw);
    if (!parsed.ok) {
      throw new Error(
        `defaults failed: ${JSON.stringify(raw.trim())}`
      );
    }
    return this.getAllSettings(opts);
  }

  async getAllSettings(
    opts?: SendCommandOptions
  ): Promise<Record<SettingsKey, string>> {
    const out = {} as Record<SettingsKey, string>;
    for (const key of SETTINGS_KEYS) {
      const { value } = await this.getSetting(key, opts);
      out[key] = value;
    }
    return out;
  }
}

/** Convenience: enumerate via default AutoTransportFactory. */
export async function enumeratePorts(): Promise<PortInfo[]> {
  return new AutoTransportFactory().enumerate();
}
