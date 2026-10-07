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
  SdSectorReader,
  WebSerialTransportFactory,
  isWebSerialAvailable,
  type CliCommand,
  type ConnectOptions,
  type ConnectionStatus,
  type ParsedStatus,
  type PortInfo,
  type SdReadResult,
  type SettingsKey,
  type WebSerialRequestPortOptions,
} from "@bobflight/protocol";
import type { BobFlightHost } from "./types";
import { CommandGate } from "./commandGate";
import { StorageActivity, isStorageCommand } from "./storageActivity";

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

/** Derive ConnectOptions.transport from path / explicit transport. Fail closed on contradictory hints. */
export function resolveConnectOptions(options: ConnectOptions): ConnectOptions {
  const rawPath = options.path;
  const explicitTransport = options.transport;

  const isMockPath = !rawPath || rawPath.startsWith("mock:") || rawPath === MOCK_PORT_PATH;
  const isWebSerialPath = typeof rawPath === "string" && rawPath.startsWith("webserial:");

  let actualRoute: "mock" | "webserial" | "serial";
  let normalizedPath: string;

  if (isMockPath) {
    actualRoute = "mock";
    normalizedPath = rawPath && rawPath.startsWith("mock:") ? rawPath : MOCK_PORT_PATH;
  } else if (isWebSerialPath) {
    actualRoute = "webserial";
    normalizedPath = rawPath;
  } else {
    actualRoute = "serial";
    normalizedPath = rawPath;
  }

  if (explicitTransport !== undefined) {
    if (explicitTransport !== actualRoute) {
      throw new Error(
        `Contradictory or mismatched connect options: transport '${explicitTransport}' does not match path '${rawPath ?? ""}' (routed as ${actualRoute})`
      );
    }
  }

  return {
    ...options,
    path: normalizedPath,
    transport: actualRoute,
  };
}

class ProtocolHostAdapter implements BobFlightHost {
  private client: BobFlightCliClient;
  private webSerial = new WebSerialTransportFactory();
  private lastError: string | null = null;
  private sessionGeneration = 0;
  private commands = new CommandGate(() => this.sessionGeneration);
  /** `sd read` helper holding the same CommandGate as every other UI command. */
  private sdReader = new SdSectorReader(this.commands, (cmd, opts) => this.client.sendCommand(cmd, opts));
  /** Settings storage actions in flight (save, defaults, `storage` reads), host-wide. */
  private storage = new StorageActivity();
  private isLiveTransport = false;
  private connectionAttempt = 0;
  readonly mode: ProtocolMode;

  constructor(mode: ProtocolMode) {
    this.mode = mode;
    // Auto supports mock://, webserial:, and native serialport paths.
    this.client = new BobFlightCliClient(new AutoTransportFactory());
    this.client.onStatus((s) => {
      this.sessionGeneration++;
      if (s !== "connected") {
        this.isLiveTransport = false;
      }
    });
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

  isLiveConnection(): boolean {
    return this.client.getConnectionStatus() === "connected" && this.isLiveTransport;
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
    const attempt = ++this.connectionAttempt;
    this.lastError = null;
    this.isLiveTransport = false;
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
      if (
        attempt === this.connectionAttempt &&
        (opts.transport === "webserial" || opts.transport === "serial") &&
        this.client.getConnectionStatus() === "connected"
      ) {
        this.isLiveTransport = true;
      }
    } catch (err) {
      if (attempt === this.connectionAttempt) {
        this.isLiveTransport = false;
        this.lastError = err instanceof Error ? err.message : String(err);
      }
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.connectionAttempt++;
    this.isLiveTransport = false;
    this.lastError = null;
    await this.client.disconnect();
  }

  async sendCommand(cmd: CliCommand): Promise<string> {
    try {
      const run = () => this.commands.run(() => this.client.sendCommand(cmd), cmd === "motor_test 0");
      return await (isStorageCommand(cmd) ? this.storage.track(run) : run());
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  storageActionPending(): boolean {
    return this.storage.pending;
  }

  onStorageActivity(cb: () => void): () => void {
    return this.storage.subscribe(cb);
  }

  async readSdSector(sector: number): Promise<SdReadResult> {
    try {
      return await this.sdReader.read(sector);
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
      await this.storage.track(() => this.commands.run(() => this.client.saveSettings()));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async restoreDefaults(): Promise<Record<SettingsKey, string>> {
    try {
      return await this.storage.track(() => this.commands.run(() => this.client.restoreDefaults()));
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
