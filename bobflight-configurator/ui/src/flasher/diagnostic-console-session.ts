/**
 * F405 USB Diagnostic Console Session helper.
 * Handles WebSerial port selection, VID/PID check, baud rate / DTR signal setup,
 * banner fragment verification, output bounding (16 KiB limit, 1024 char scan window),
 * allowlisted command transmission, mutual exclusion, and clean disconnects.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

export const TARGET_VID = 0x1209;
export const TARGET_PID = 0xb0b1;
export const KNOWN_BANNER_FRAGMENT = "BobFlight F405 USB diagnostic, MLTEMPF4 reference";
export const DEFAULT_IDENTITY_TIMEOUT_MS = 10000;
export const MAX_OUTPUT_CHARS = 16384;
export const IDENTITY_SCAN_CHARS = 1024;
export const BAUD_RATE = 115200;

export const ALLOWED_COMMANDS = ["version", "status", "help"] as const;
export type DiagnosticCommand = (typeof ALLOWED_COMMANDS)[number];

export type SessionState =
  | "disconnected"
  | "selecting"
  | "opening"
  | "verifying"
  | "connected"
  | "closing";

export interface SerialPortInfo {
  usbVendorId?: number;
  usbProductId?: number;
}

export interface SerialOptions {
  baudRate: number;
}

export interface SerialOutputSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
}

export interface MinimalReadableStreamReader<R> {
  read(): Promise<{ done: boolean; value?: R }>;
  cancel(): Promise<void>;
  releaseLock(): void;
}

export interface MinimalReadableStream<R> {
  getReader(): MinimalReadableStreamReader<R>;
}

export interface MinimalWritableStreamWriter<W> {
  write(chunk: W): Promise<void>;
  releaseLock(): void;
}

export interface MinimalWritableStream<W> {
  getWriter(): MinimalWritableStreamWriter<W>;
}

export interface MinimalSerialPort {
  getInfo(): SerialPortInfo;
  open(options: SerialOptions): Promise<void>;
  setSignals?(signals: SerialOutputSignals): Promise<void>;
  close(): Promise<void>;
  readable: MinimalReadableStream<Uint8Array> | null;
  writable: MinimalWritableStream<Uint8Array> | null;
}

export interface MinimalNavigatorSerial {
  requestPort(options?: {
    filters?: Array<{ usbVendorId?: number; usbProductId?: number }>;
  }): Promise<MinimalSerialPort>;
}

export function getNavigatorSerial(): MinimalNavigatorSerial | undefined {
  if (typeof navigator !== "undefined" && "serial" in navigator) {
    return (navigator as unknown as { serial: MinimalNavigatorSerial }).serial;
  }
  return undefined;
}

export interface DiagnosticConsoleSessionOptions {
  onOutput?: (output: string) => void;
  onStateChange?: (state: SessionState) => void;
  onError?: (error: string | null) => void;
  onActiveChange?: (active: boolean) => void;
  requestPortOverride?: () => Promise<MinimalSerialPort>;
  timeoutMs?: number;
}

export class DiagnosticConsoleSession {
  private state: SessionState = "disconnected";
  private output = "";
  private verified = false;
  private active = false;
  private lastError: string | null = null;

  private port: MinimalSerialPort | null = null;
  private reader: MinimalReadableStreamReader<Uint8Array> | null = null;
  private writerLock = false;
  private openingPromise: Promise<void> | null = null;
  private writingPromise: Promise<void> | null = null;
  private closingPromise: Promise<void> | null = null;
  private identityTimer: ReturnType<typeof setTimeout> | null = null;
  private cancelPending = false;
  private readLoopPromise: Promise<void> | null = null;

  private onOutputCallback?: (output: string) => void;
  private onStateChangeCallback?: (state: SessionState) => void;
  private onErrorCallback?: (error: string | null) => void;
  private onActiveChangeCallback?: (active: boolean) => void;
  private requestPortOverride?: () => Promise<MinimalSerialPort>;
  private timeoutMs: number;

  constructor(options: DiagnosticConsoleSessionOptions = {}) {
    this.onOutputCallback = options.onOutput;
    this.onStateChangeCallback = options.onStateChange;
    this.onErrorCallback = options.onError;
    this.onActiveChangeCallback = options.onActiveChange;
    this.requestPortOverride = options.requestPortOverride;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_IDENTITY_TIMEOUT_MS;
  }

  getState(): SessionState {
    return this.state;
  }

  getOutput(): string {
    return this.output;
  }

  isVerified(): boolean {
    return this.verified;
  }

  isActive(): boolean {
    return this.active;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  setCallbacks(options: DiagnosticConsoleSessionOptions) {
    if (options.onOutput !== undefined) this.onOutputCallback = options.onOutput;
    if (options.onStateChange !== undefined) this.onStateChangeCallback = options.onStateChange;
    if (options.onError !== undefined) this.onErrorCallback = options.onError;
    if (options.onActiveChange !== undefined) this.onActiveChangeCallback = options.onActiveChange;
    if (options.requestPortOverride !== undefined) this.requestPortOverride = options.requestPortOverride;
    if (options.timeoutMs !== undefined) this.timeoutMs = options.timeoutMs;
  }

  private setState(newState: SessionState) {
    this.state = newState;
    this.onStateChangeCallback?.(newState);

    const newActive = newState !== "disconnected";
    if (this.active !== newActive) {
      this.active = newActive;
      this.onActiveChangeCallback?.(newActive);
    }
  }

  private setError(err: string | null) {
    this.lastError = err;
    this.onErrorCallback?.(err);
  }

  private appendOutput(text: string) {
    this.output += text;
    if (this.output.length > MAX_OUTPUT_CHARS) {
      this.output = this.output.slice(this.output.length - MAX_OUTPUT_CHARS);
    }
    this.onOutputCallback?.(this.output);

    if (!this.verified) {
      const scanWindow = this.output.slice(-IDENTITY_SCAN_CHARS);
      if (scanWindow.includes(KNOWN_BANNER_FRAGMENT)) {
        this.verified = true;
        if (this.identityTimer !== null) {
          clearTimeout(this.identityTimer);
          this.identityTimer = null;
        }
        if (this.state === "verifying") {
          this.setState("connected");
        }
      }
    }
  }

  async connect(): Promise<void> {
    if (this.state !== "disconnected") return;
    const opening = this.openConnection();
    this.openingPromise = opening;
    try { await opening; }
    catch (error) { this.setError(`Diagnostic connection failed: ${String(error)}`); this.cancelPending = true; }
    finally { this.openingPromise = null; }
    if (this.cancelPending) await this.close();
  }

  private async openConnection(): Promise<void> {
    // Reentry doubleclick guard
    if (this.state !== "disconnected") {
      return;
    }

    this.cancelPending = false;
    this.verified = false;
    this.output = "";
    this.onOutputCallback?.("");
    this.setError(null);

    this.setState("selecting");

    let port: MinimalSerialPort;
    try {
      if (this.requestPortOverride) {
        port = await this.requestPortOverride();
      } else {
        const navSerial = getNavigatorSerial();
        if (!navSerial) {
          throw new Error("WebSerial API is not supported in this browser.");
        }
        port = await navSerial.requestPort({
          filters: [{ usbVendorId: TARGET_VID, usbProductId: TARGET_PID }],
        });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setError(`Port selection failed: ${msg}`);
      if (!this.cancelPending) this.setState("disconnected");
      return;
    }

    if (this.cancelPending) return;

    // Exact VID/PID verification
    const info = port.getInfo();
    if (info.usbVendorId !== TARGET_VID || info.usbProductId !== TARGET_PID) {
      const vidHex = info.usbVendorId !== undefined ? `0x${info.usbVendorId.toString(16)}` : "unknown";
      const pidHex = info.usbProductId !== undefined ? `0x${info.usbProductId.toString(16)}` : "unknown";
      this.setError(`Invalid USB device VID/PID (${vidHex}:${pidHex}). Expected 0x1209:0xB0B1.`);
      if (!this.cancelPending) this.setState("disconnected");
      return;
    }

    this.port = port;
    this.setState("opening");

    try {
      await port.open({ baudRate: BAUD_RATE });
      if (!this.cancelPending) {
        if (!port.setSignals) throw new Error("DTR signal control is required for this diagnostic.");
        await port.setSignals({ dataTerminalReady: true, requestToSend: false });
        if (!port.readable || !port.writable) throw new Error("Diagnostic serial streams are unavailable.");
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.setError(`Failed to open serial port: ${msg}`);
      const closed = await this.cleanupPort();
      if (!this.cancelPending) this.setState(closed ? "disconnected" : "closing");
      return;
    }

    if (this.cancelPending) {
      const closed = await this.cleanupPort();
      if (!this.cancelPending) this.setState(closed ? "disconnected" : "closing");
      return;
    }

    this.setState("verifying");

    // Start identity verification timeout
    this.identityTimer = setTimeout(() => {
      if (!this.verified && this.state === "verifying") {
        this.setError("Diagnostic identity timeout (10s): wrong or missing diagnostic identity.");
        void this.close();
      }
    }, this.timeoutMs);

    // Start background reading
    this.readLoopPromise = this.runReadLoop();
  }

  private async runReadLoop(): Promise<void> {
    if (!this.port || !this.port.readable) return;

    try {
      this.reader = this.port.readable.getReader();
      const decoder = new TextDecoder();

      while (this.state === "verifying" || this.state === "connected") {
        const { done, value } = await this.reader.read();
        if (done || this.cancelPending) break;
        if (value) {
          const text = decoder.decode(value, { stream: true });
          this.appendOutput(text);
        }
      }
    } catch (err: unknown) {
      if (this.state === "verifying" || this.state === "connected") {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("canceled") && !msg.includes("cancelled")) {
          this.setError(`Diagnostic port disconnected: ${msg}`);
        }
      }
    } finally {
      if (this.reader) {
        try {
          this.reader.releaseLock();
        } catch {}
        this.reader = null;
      }
      if (!this.verified && (this.state === "verifying" || this.state === "connected")) {
        if (!this.lastError) {
          this.setError("Diagnostic identity mismatch or connection dropped before verification.");
        }
      }
      if (this.state !== "closing" && this.state !== "disconnected") {
        void this.close();
      }
    }
  }

  async sendCommand(cmd: DiagnosticCommand): Promise<void> {
    if (!ALLOWED_COMMANDS.includes(cmd)) {
      throw new Error(`Command '${cmd}' is not allowed. Allowed commands: ${ALLOWED_COMMANDS.join(", ")}`);
    }

    if (this.state !== "connected" || !this.verified || !this.port || !this.port.writable) {
      throw new Error("Cannot send command: port not connected or identity not verified.");
    }

    if (this.writerLock) {
      throw new Error("Writer is busy.");
    }

    this.writerLock = true;
    const writing = (async () => {
      let writer: MinimalWritableStreamWriter<Uint8Array> | null = null;
      try {
        writer = this.port!.writable!.getWriter();
        await writer.write(new TextEncoder().encode(cmd + "\n"));
      } finally {
        if (writer) { try { writer.releaseLock(); } catch {} }
        this.writerLock = false;
      }
    })();
    this.writingPromise = writing;
    try { await writing; } finally { this.writingPromise = null; }
  }

  async close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    if (this.state === "disconnected") return;
    this.cancelPending = true;
    this.verified = false;
    this.setState("closing");
    if (this.identityTimer !== null) {
      clearTimeout(this.identityTimer); this.identityTimer = null;
    }
    const closing = this.finishClose();
    this.closingPromise = closing;
    try { await closing; } finally { this.closingPromise = null; }
  }

  private async finishClose(): Promise<void> {
    // Do not release ownership while a picker/open can still return a port.
    if (this.openingPromise) { try { await this.openingPromise; } catch {} }
    if (this.reader) { try { await this.reader.cancel(); } catch {} }
    // The read loop owns releaseLock(). Wait for it, and any in-flight write.
    if (this.readLoopPromise) {
      try { await this.readLoopPromise; } catch {}
      this.readLoopPromise = null;
    }
    if (this.writingPromise) { try { await this.writingPromise; } catch {} }
    if (await this.cleanupPort()) this.setState("disconnected");
  }

  private async cleanupPort(): Promise<boolean> {
    if (!this.port) return true;
    const port = this.port;
    try {
      try { await port.setSignals?.({dataTerminalReady:false,requestToSend:false}); } catch {}
      await port.close();
    }
    catch (error) {
      if (port.readable || port.writable) {
        this.setError(`Could not close diagnostic port. Retry Close: ${String(error)}`);
        return false;
      }
    }
    this.port = null;
    return true;
  }
}
