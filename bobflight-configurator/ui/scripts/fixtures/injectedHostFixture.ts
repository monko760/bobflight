/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import type {
  BobFlightHost,
  ConnectionStatus,
  ConnectOptions,
  ParsedStatus,
  PortInfo,
  CliCommand,
  SettingsKey,
} from "../../src/protocol/types";

export class TestInjectedHost implements BobFlightHost {
  connectionStatus: ConnectionStatus = "disconnected";
  isLive: boolean = true;
  versionValue: string | null = "BobFlight 1.0.0";
  statusValue: ParsedStatus | null = { board: "tmotor_f7_v2", armingPreventedReason: "none" } as ParsedStatus;

  versionError: Error | null = null;
  statusError: Error | null = null;

  versionDelayMs: number = 0;
  statusDelayMs: number = 0;

  private statusListeners = new Set<(s: ConnectionStatus) => void>();
  private lineListeners = new Set<(l: string) => void>();
  private lastError: string | null = null;

  setConnectionStatus(s: ConnectionStatus) {
    this.connectionStatus = s;
    for (const cb of this.statusListeners) {
      try {
        cb(s);
      } catch {}
    }
  }

  isLiveConnection(): boolean {
    return this.connectionStatus === "connected" && this.isLive;
  }

  getConnectionStatus(): ConnectionStatus {
    return this.connectionStatus;
  }

  async connect(_options: ConnectOptions): Promise<void> {
    this.setConnectionStatus("connected");
  }

  async disconnect(): Promise<void> {
    this.setConnectionStatus("disconnected");
  }

  async getVersion(): Promise<string> {
    if (this.versionDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.versionDelayMs));
    }
    if (this.versionError) {
      throw this.versionError;
    }
    return this.versionValue ?? "";
  }

  async getStatus(): Promise<ParsedStatus> {
    if (this.statusDelayMs > 0) {
      await new Promise((r) => setTimeout(r, this.statusDelayMs));
    }
    if (this.statusError) {
      throw this.statusError;
    }
    if (!this.statusValue) {
      throw new Error("No status available");
    }
    return this.statusValue;
  }

  onStatus(cb: (s: ConnectionStatus) => void): () => void {
    this.statusListeners.add(cb);
    cb(this.connectionStatus);
    return () => this.statusListeners.delete(cb);
  }

  onLine(cb: (line: string) => void): () => void {
    this.lineListeners.add(cb);
    return () => this.lineListeners.delete(cb);
  }

  getLastError(): string | null {
    return this.lastError;
  }

  async enumeratePorts(): Promise<PortInfo[]> { return []; }
  async sendCommand(_cmd: CliCommand): Promise<string> { return "ok"; }
  async requestPort(): Promise<PortInfo> { throw new Error("not implemented"); }
  async getSetting(key: SettingsKey): Promise<{ key: SettingsKey; value: string }> { return { key, value: "1000" }; }
  async setSetting(key: SettingsKey, value: string): Promise<{ key: SettingsKey; value: string }> { return { key, value }; }
  async saveSettings(): Promise<void> {}
  async restoreDefaults(): Promise<Record<SettingsKey, string>> { return {}; }
  async getAllSettings(): Promise<Record<SettingsKey, string>> { return {}; }
}

let activeHost: TestInjectedHost | null = null;

export function setInjectedHost(host: TestInjectedHost) {
  activeHost = host;
}

export function createHost(): BobFlightHost {
  if (!activeHost) {
    activeHost = new TestInjectedHost();
  }
  return activeHost;
}
