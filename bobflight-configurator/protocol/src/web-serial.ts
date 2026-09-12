/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Browser Web Serial API transport (Chrome/Edge USB CDC).
 * Ambient SerialPort subset — no DOM lib required for Node tsc.
 */

import { EventEmitter } from "events";
import type { PortInfo } from "./types";
import type { SerialPortLike, TransportFactory } from "./transport";
import { DEFAULT_BAUD_RATE } from "./transport";

/** Minimal Web Serial readable stream reader. */
interface WebSerialReadableStreamDefaultReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  releaseLock(): void;
  cancel(): Promise<void>;
}

/** Minimal Web Serial writable stream writer. */
interface WebSerialWritableStreamDefaultWriter {
  write(chunk: Uint8Array): Promise<void>;
  releaseLock(): void;
}

/** Minimal subset of the Web Serial API SerialPort. */
export interface WebSerialPortNative {
  readonly readable: {
    getReader(): WebSerialReadableStreamDefaultReader;
  } | null;
  readonly writable: {
    getWriter(): WebSerialWritableStreamDefaultWriter;
  } | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  getInfo(): {
    usbVendorId?: number;
    usbProductId?: number;
    serialNumber?: string;
  };
}

interface WebSerialRequestOptions {
  filters?: Array<{
    usbVendorId?: number;
    usbProductId?: number;
  }>;
}

interface NavigatorSerial {
  getPorts(): Promise<WebSerialPortNative[]>;
  requestPort(options?: WebSerialRequestOptions): Promise<WebSerialPortNative>;
}

const PATH_PREFIX = "webserial:";

/** Module-level path → native port registry. */
const registeredPorts = new Map<string, WebSerialPortNative>();
/** Stable path assignment for ports without serialNumber. */
const portIdentity = new WeakMap<WebSerialPortNative, string>();
let incrementalId = 0;

function getNavigatorSerial(): NavigatorSerial | null {
  const g = globalThis as {
    navigator?: { serial?: NavigatorSerial };
    window?: { isSecureContext?: boolean };
    isSecureContext?: boolean;
  };
  const nav = g.navigator;
  if (!nav || !nav.serial) return null;
  return nav.serial;
}

function isSecureContext(): boolean {
  const g = globalThis as {
    window?: { isSecureContext?: boolean };
    isSecureContext?: boolean;
  };
  if (typeof g.window !== "undefined" && g.window !== null) {
    return g.window.isSecureContext === true;
  }
  return g.isSecureContext === true;
}

/** True when `navigator.serial` exists and the page is a secure context. */
export function isWebSerialAvailable(): boolean {
  return getNavigatorSerial() !== null && isSecureContext();
}

/** Human-readable reason Web Serial cannot be used, or null if available. */
export function webSerialUnavailableReason(): string | null {
  if (typeof (globalThis as { window?: unknown }).window === "undefined") {
    return "not a browser environment (no window)";
  }
  if (!isSecureContext()) {
    return "Web Serial requires a secure context (HTTPS or localhost)";
  }
  if (getNavigatorSerial() === null) {
    return "navigator.serial is not available (use Chrome/Edge with Web Serial)";
  }
  return null;
}

function hexId(n: number | undefined): string {
  if (n === undefined || n === null) return "0";
  return n.toString(16).padStart(4, "0");
}

/**
 * Stable-ish path: webserial:<vendor>-<product>-<serial|n>
 * Registered in the module Map for open() lookup.
 */
export function pathForWebSerialPort(port: WebSerialPortNative): string {
  const existing = portIdentity.get(port);
  if (existing) return existing;

  const info = port.getInfo();
  const sn =
    info.serialNumber && info.serialNumber.length > 0
      ? info.serialNumber.replace(/[^a-zA-Z0-9_-]/g, "_")
      : `n${++incrementalId}`;
  const id = `${hexId(info.usbVendorId)}-${hexId(info.usbProductId)}-${sn}`;
  const path = `${PATH_PREFIX}${id}`;
  portIdentity.set(port, path);
  registeredPorts.set(path, port);
  return path;
}

function portInfoFromNative(port: WebSerialPortNative): PortInfo {
  const info = port.getInfo();
  const path = pathForWebSerialPort(port);
  return {
    path,
    vendorId:
      info.usbVendorId !== undefined
        ? hexId(info.usbVendorId)
        : undefined,
    productId:
      info.usbProductId !== undefined
        ? hexId(info.usbProductId)
        : undefined,
    serialNumber: info.serialNumber,
    manufacturer: "Web Serial",
    friendlyName: `Web Serial ${path.slice(PATH_PREFIX.length)}`,
  };
}

function findRegisteredPort(path: string): WebSerialPortNative | undefined {
  return registeredPorts.get(path);
}

/**
 * EventEmitter SerialPortLike backed by a Web Serial API port.
 * Read loop on port.readable; writes via writable.getWriter().
 */
export class WebSerialPort extends EventEmitter implements SerialPortLike {
  readonly path: string;
  readonly baudRate: number;
  private native: WebSerialPortNative;
  private _isOpen = false;
  private readAbort = false;
  private reader: WebSerialReadableStreamDefaultReader | null = null;

  constructor(native: WebSerialPortNative, path: string, baudRate: number) {
    super();
    this.native = native;
    this.path = path;
    this.baudRate = baudRate;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  async open(): Promise<void> {
    if (this._isOpen) return;
    await this.native.open({ baudRate: this.baudRate });
    this._isOpen = true;
    this.readAbort = false;
    void this.startReadLoop();
  }

  async close(): Promise<void> {
    if (!this._isOpen) return;
    this.readAbort = true;
    try {
      if (this.reader) {
        try {
          await this.reader.cancel();
        } catch {
          /* ignore cancel errors during close */
        }
        try {
          this.reader.releaseLock();
        } catch {
          /* already released */
        }
        this.reader = null;
      }
      await this.native.close();
    } finally {
      this._isOpen = false;
      this.emit("close");
    }
  }

  write(data: string | Buffer, encoding?: BufferEncoding): boolean {
    if (!this._isOpen) {
      this.emit("error", new Error("WebSerialPort is not open"));
      return false;
    }
    const writable = this.native.writable;
    if (!writable) {
      this.emit("error", new Error("WebSerialPort writable stream unavailable"));
      return false;
    }
    const buf =
      typeof data === "string"
        ? Buffer.from(data, encoding ?? "utf8")
        : data;
    const writer = writable.getWriter();
    void writer
      .write(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      .then(() => {
        writer.releaseLock();
      })
      .catch((err: unknown) => {
        try {
          writer.releaseLock();
        } catch {
          /* ignore */
        }
        this.emit(
          "error",
          err instanceof Error ? err : new Error(String(err))
        );
      });
    return true;
  }

  private async startReadLoop(): Promise<void> {
    const readable = this.native.readable;
    if (!readable) {
      this.emit("error", new Error("WebSerialPort readable stream unavailable"));
      return;
    }
    this.reader = readable.getReader();
    try {
      while (!this.readAbort && this._isOpen) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          this.emit("data", Buffer.from(value));
        }
      }
    } catch (err) {
      if (!this.readAbort) {
        this.emit(
          "error",
          err instanceof Error ? err : new Error(String(err))
        );
      }
    } finally {
      try {
        this.reader?.releaseLock();
      } catch {
        /* ignore */
      }
      this.reader = null;
    }
  }
}

export interface WebSerialRequestPortOptions {
  filters?: Array<{
    usbVendorId?: number;
    usbProductId?: number;
  }>;
}

/** TransportFactory for browser `navigator.serial` (Chrome/Edge USB CDC). */
export class WebSerialTransportFactory implements TransportFactory {
  async enumerate(): Promise<PortInfo[]> {
    const serial = getNavigatorSerial();
    if (!serial || !isSecureContext()) {
      return [];
    }
    const ports = await serial.getPorts();
    return ports.map((p) => portInfoFromNative(p));
  }

  /**
   * User-gesture picker: `navigator.serial.requestPort`.
   * Registers the chosen port and returns PortInfo with webserial: path.
   */
  async requestPort(
    opts?: WebSerialRequestPortOptions
  ): Promise<PortInfo> {
    if (!isWebSerialAvailable()) {
      throw new Error(
        webSerialUnavailableReason() ?? "Web Serial unavailable"
      );
    }
    const serial = getNavigatorSerial()!;
    const port = await serial.requestPort(
      opts?.filters ? { filters: opts.filters } : undefined
    );
    return portInfoFromNative(port);
  }

  async open(options: {
    path: string;
    baudRate: number;
  }): Promise<SerialPortLike> {
    if (!isWebSerialAvailable()) {
      throw new Error(
        webSerialUnavailableReason() ?? "Web Serial unavailable"
      );
    }
    let native = findRegisteredPort(options.path);
    if (!native) {
      // Refresh from getPorts() and re-register
      const serial = getNavigatorSerial()!;
      const ports = await serial.getPorts();
      for (const p of ports) {
        const info = portInfoFromNative(p);
        if (info.path === options.path) {
          native = p;
          break;
        }
      }
    }
    if (!native) {
      throw new Error(
        `Web Serial port not found: ${options.path}. ` +
          `Call requestPort() first (requires a user gesture).`
      );
    }
    const baud = options.baudRate || DEFAULT_BAUD_RATE;
    const adapter = new WebSerialPort(native, options.path, baud);
    await adapter.open();
    return adapter;
  }
}
