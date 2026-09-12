/**
 * UI host factory — imports BobFlightCliClient from @bobflight/protocol.
 *
 * Always uses AutoTransportFactory so Connect can select mock://bobflight
 * (default) or a webserial: path after Request USB port.
 *
 * Vite polyfills buffer/events; serialport is stubbed for browser builds.
 * If full CliClient ever fails in-browser, fall back documented below.
 */
import {
  AutoTransportFactory,
  BobFlightCliClient,
  MOCK_PORT_PATH,
  WebSerialTransportFactory,
  isWebSerialAvailable,
  type CliCommand,
  type ConnectOptions,
  type ConnectionStatus,
  type ParsedStatus,
  type PortInfo,
  type SettingsKey,
  type WebSerialRequestPortOptions,
} from "@bobflight/protocol";
import type { BobFlightHost } from "./types";
import { CommandGate } from "./commandGate";

export type ProtocolMode = "mock" | "serial";

function waitReadyBanner(
  client: BobFlightCliClient,
  timeoutMs = 2000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      off();
      reject(
        new Error(
          "connect banner timeout (expected BobFlight … ready before settings)",
        ),
      );
    }, timeoutMs);
    const off = client.onLine((line) => {
      if (line.startsWith("BobFlight") && line.includes("ready")) {
        clearTimeout(t);
        off();
        resolve(line);
      }
    });
  });
}

/** Derive ConnectOptions.transport from path / explicit transport. */
export function resolveConnectOptions(options: ConnectOptions): ConnectOptions {
  const path = options.path || MOCK_PORT_PATH;
  if (path.startsWith("webserial:") || options.transport === "webserial") {
    return { ...options, path, transport: "webserial" };
  }
  if (
    path.startsWith("mock:") ||
    path === MOCK_PORT_PATH ||
    options.transport === "mock"
  ) {
    return {
      ...options,
      path: path.startsWith("mock:") ? path : MOCK_PORT_PATH,
      transport: "mock",
    };
  }
  return { ...options, path, transport: options.transport ?? "serial" };
}

class ProtocolHostAdapter implements BobFlightHost {
  private client: BobFlightCliClient;
  private webSerial = new WebSerialTransportFactory();
  private lastError: string | null = null;
  private sessionGeneration = 0;
  private commands = new CommandGate(() => this.sessionGeneration);
  readonly mode: ProtocolMode;

  constructor(mode: ProtocolMode) {
    this.mode = mode;
    // Auto supports mock://, webserial:, and native serialport paths.
    this.client = new BobFlightCliClient(new AutoTransportFactory());
    this.client.onStatus(() => { this.sessionGeneration++; });
  }

  /** Escape hatch for advanced callers; pages should prefer host settings APIs. */
  getClient(): BobFlightCliClient {
    return this.client;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getConnectionStatus(): ConnectionStatus {
    return this.client.getConnectionStatus();
  }

  onLine(cb: (line: string) => void): () => void {
    return this.client.onLine(cb);
  }

  onStatus(cb: (s: ConnectionStatus) => void): () => void {
    return this.client.onStatus(cb);
  }

  /**
   * Browser host: only mock:// and webserial: paths.
   * Prefer Web Serial getPorts() for already-permitted devices; never
   * expose Node serialport enumerate results in the UI.
   */
  async enumeratePorts(): Promise<PortInfo[]> {
    const byPath = new Map<string, PortInfo>();

    try {
      const fromClient = await this.client.enumeratePorts();
      for (const p of fromClient) {
        if (p.path.startsWith("mock") || p.path.startsWith("webserial:")) {
          byPath.set(p.path, p);
        }
      }
    } catch {
      /* ignore client enumerate failures */
    }

    if (isWebSerialAvailable()) {
      try {
        const web = await this.webSerial.enumerate();
        for (const p of web) {
          byPath.set(p.path, p);
        }
      } catch {
        /* ignore Web Serial getPorts failures */
      }
    }

    if (![...byPath.keys()].some((k) => k.startsWith("mock"))) {
      byPath.set(MOCK_PORT_PATH, {
        path: MOCK_PORT_PATH,
        friendlyName: "Mock BobFlight CDC",
        manufacturer: "BobFlight",
      });
    }

    return Array.from(byPath.values());
  }

  /** Explicit refresh of already-granted Web Serial ports via getPorts(). */
  async refreshWebSerialPorts(): Promise<PortInfo[]> {
    if (!isWebSerialAvailable()) return [];
    try {
      return await this.webSerial.enumerate();
    } catch {
      return [];
    }
  }

  async requestPort(
    opts?: WebSerialRequestPortOptions,
  ): Promise<PortInfo> {
    this.lastError = null;
    try {
      return await this.webSerial.requestPort(opts);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async connect(options: ConnectOptions): Promise<void> {
    this.lastError = null;
    try {
      const opts = resolveConnectOptions(options);
      const isMock = opts.transport === "mock";
      // SAFETY: BobFlightCliClient.connect never auto-arms.
      // Wait for fire-and-forget connect banner before callers run get/set.
      const bannerPromise = waitReadyBanner(this.client);
      void bannerPromise.catch(() => {});
      await this.client.connect(opts);
      try {
        await bannerPromise;
      } catch (bannerErr) {
        if (isMock) throw bannerErr;
        console.warn(
          "[bobflight-ui] connect banner not seen; proceeding",
          bannerErr,
        );
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.lastError = null;
    await this.client.disconnect();
  }

  async sendCommand(cmd: CliCommand): Promise<string> {
    try {
      return await this.commands.run(() => this.client.sendCommand(cmd), cmd === "motor_test 0");
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async getVersion(): Promise<string> {
    try {
      return await this.commands.run(() => this.client.getVersion());
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async getStatus(): Promise<ParsedStatus> {
    try {
      return await this.commands.run(() => this.client.getStatus());
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async getSetting(
    key: SettingsKey,
  ): Promise<{ key: SettingsKey; value: string }> {
    try {
      return await this.commands.run(() => this.client.getSetting(key));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async setSetting(
    key: SettingsKey,
    value: string,
  ): Promise<{ key: SettingsKey; value: string }> {
    try {
      return await this.commands.run(() => this.client.setSetting(key, value));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async saveSettings(): Promise<void> {
    try {
      await this.commands.run(() => this.client.saveSettings());
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async restoreDefaults(): Promise<Record<SettingsKey, string>> {
    try {
      return await this.commands.run(() => this.client.restoreDefaults());
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async getAllSettings(): Promise<Record<SettingsKey, string>> {
    try {
      return await this.commands.run(() => this.client.getAllSettings());
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }
}

export function createHost(mode?: ProtocolMode): BobFlightHost {
  const envMode = (import.meta.env.VITE_PROTOCOL_MODE ?? "mock").toLowerCase();
  const resolved: ProtocolMode =
    mode ?? (envMode === "serial" ? "serial" : "mock");

  if (resolved === "serial") {
    console.warn(
      "[bobflight-ui] serial uses AutoTransportFactory; native serialport may be unavailable in browser — prefer mock or Web Serial",
    );
  }

  // TODO(browser): If BobFlightCliClient + polyfills fail in a target browser,
  // keep importing parseStatus/MOCK_PORT_PATH/types from @bobflight/protocol and
  // wrap a thin adapter with the same API surface (do not fork protocol/).
  return new ProtocolHostAdapter(resolved);
}

export function getDefaultBaudRates(): number[] {
  return [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
}

export { MOCK_PORT_PATH };

export {
  isWebSerialAvailable,
  webSerialUnavailableReason,
} from "@bobflight/protocol";
