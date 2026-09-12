/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from "events";
import type { PortInfo } from "./types";
import type { SerialPortLike, TransportFactory } from "./transport";
import { DEFAULT_BAUD_RATE } from "./transport";
import { MockSerial, MOCK_PORT_PATH } from "./mock-serial";
import {
  WebSerialTransportFactory,
  isWebSerialAvailable,
} from "./web-serial";

type SerialPortCtor = new (opts: {
  path: string;
  baudRate: number;
  autoOpen?: boolean;
}) => SerialPortNative;

interface SerialPortNative extends EventEmitter {
  path: string;
  baudRate: number;
  isOpen: boolean;
  open(cb: (err: Error | null) => void): void;
  close(cb: (err: Error | null) => void): void;
  write(
    data: string | Buffer,
    encoding?: BufferEncoding,
    cb?: (err: Error | null) => void
  ): boolean;
}

interface SerialPortListEntry {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
  friendlyName?: string;
}

let serialportModule: {
  SerialPort: SerialPortCtor;
  SerialPortMock?: unknown;
} | null = null;
let serialportLoadAttempted = false;
let serialportLoadError: string | null = null;

function tryLoadSerialport(): typeof serialportModule {
  if (serialportLoadAttempted) return serialportModule;
  serialportLoadAttempted = true;
  try {
    // Optional native dependency — may fail to build on some hosts.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    serialportModule = require("serialport") as typeof serialportModule;
  } catch (err) {
    serialportLoadError =
      err instanceof Error ? err.message : String(err);
    serialportModule = null;
  }
  return serialportModule;
}

/** Whether the optional `serialport` package loaded successfully. */
export function isSerialportAvailable(): boolean {
  return tryLoadSerialport() !== null;
}

export function serialportUnavailableReason(): string | null {
  tryLoadSerialport();
  return serialportLoadError;
}

class NativeSerialAdapter extends EventEmitter implements SerialPortLike {
  readonly path: string;
  readonly baudRate: number;
  private port: SerialPortNative;

  constructor(port: SerialPortNative, path: string, baudRate: number) {
    super();
    this.port = port;
    this.path = path;
    this.baudRate = baudRate;
    port.on("data", (chunk: Buffer) => this.emit("data", chunk));
    port.on("close", () => this.emit("close"));
    port.on("error", (err: Error) => this.emit("error", err));
  }

  get isOpen(): boolean {
    return this.port.isOpen;
  }

  open(): Promise<void> {
    if (this.port.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.port.open((err) => (err ? reject(err) : resolve()));
    });
  }

  close(): Promise<void> {
    if (!this.port.isOpen) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.port.close((err) => (err ? reject(err) : resolve()));
    });
  }

  write(data: string | Buffer, encoding?: BufferEncoding): boolean {
    return this.port.write(data, encoding);
  }
}

/** Real USB CDC via `serialport` when installable. */
export class SerialportTransportFactory implements TransportFactory {
  async enumerate(): Promise<PortInfo[]> {
    const mod = tryLoadSerialport();
    if (!mod) {
      throw new Error(
        `serialport not available: ${serialportLoadError ?? "unknown"}`
      );
    }
    // Dynamic list API (serialport v10+/v12)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SerialPort } = require("serialport") as {
      SerialPort: { list(): Promise<SerialPortListEntry[]> };
    };
    const list = await SerialPort.list();
    return list.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      serialNumber: p.serialNumber,
      vendorId: p.vendorId,
      productId: p.productId,
      pnpId: p.pnpId,
      friendlyName: p.friendlyName,
    }));
  }

  async open(options: {
    path: string;
    baudRate: number;
  }): Promise<SerialPortLike> {
    const mod = tryLoadSerialport();
    if (!mod) {
      throw new Error(
        `serialport not available: ${serialportLoadError ?? "unknown"}`
      );
    }
    const port = new mod.SerialPort({
      path: options.path,
      baudRate: options.baudRate,
      autoOpen: false,
    });
    const adapter = new NativeSerialAdapter(
      port,
      options.path,
      options.baudRate
    );
    await adapter.open();
    return adapter;
  }
}

/** Always-available MockSerial factory for smoke / UI without hardware. */
export class MockTransportFactory implements TransportFactory {
  constructor(private readonly mockOpts?: ConstructorParameters<typeof MockSerial>[2]) {}

  enumerate(): Promise<PortInfo[]> {
    return MockSerial.list();
  }

  async open(options: {
    path: string;
    baudRate: number;
  }): Promise<SerialPortLike> {
    const path = options.path.startsWith("mock:")
      ? options.path
      : MOCK_PORT_PATH;
    const mock = new MockSerial(path, options.baudRate, {
      ...(path === "mock://bobflight-bench" ? { benchReady: true, boardId: "mock-bench-SIMULATED" } : {}),
      ...this.mockOpts,
    });
    await mock.open();
    return mock;
  }
}

/**
 * Prefer serialport for real paths; MockSerial for mock:// or when forced.
 * In browser with Web Serial, include webserial: ports from getPorts().
 * If serialport is missing, real Node paths throw with a clear message.
 */
export class AutoTransportFactory implements TransportFactory {
  private readonly mock = new MockTransportFactory();
  private readonly native = new SerialportTransportFactory();
  private readonly webSerial = new WebSerialTransportFactory();

  async enumerate(): Promise<PortInfo[]> {
    const mockPorts = await this.mock.enumerate();
    const ports: PortInfo[] = [...mockPorts];

    if (isWebSerialAvailable()) {
      try {
        const web = await this.webSerial.enumerate();
        ports.push(...web);
      } catch {
        /* ignore Web Serial enumerate failures */
      }
    }

    if (isSerialportAvailable()) {
      try {
        const real = await this.native.enumerate();
        ports.push(...real);
      } catch {
        /* ignore native enumerate failures */
      }
    }

    return ports;
  }

  async open(options: {
    path: string;
    baudRate: number;
  }): Promise<SerialPortLike> {
    if (
      options.path.startsWith("mock:") ||
      options.path === MOCK_PORT_PATH
    ) {
      return this.mock.open(options);
    }
    if (options.path.startsWith("webserial:")) {
      return this.webSerial.open({
        path: options.path,
        baudRate: options.baudRate || DEFAULT_BAUD_RATE,
      });
    }
    if (!isSerialportAvailable()) {
      throw new Error(
        `Cannot open ${options.path}: serialport native module unavailable ` +
          `(${serialportUnavailableReason() ?? "not installed"}). ` +
          `Use path "${MOCK_PORT_PATH}" for MockSerial smoke.`
      );
    }
    return this.native.open({
      path: options.path,
      baudRate: options.baudRate || DEFAULT_BAUD_RATE,
    });
  }
}
