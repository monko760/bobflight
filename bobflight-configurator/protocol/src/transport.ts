/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PortInfo } from "./types";

/**
 * Minimal SerialPort-like interface used by BobFlightCliClient.
 * Real USB CDC uses serialport when available; MockSerial implements this.
 */
export interface SerialPortLike {
  readonly path: string;
  readonly baudRate: number;
  readonly isOpen: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  write(data: string | Buffer, encoding?: BufferEncoding): boolean;
  on(event: "data", cb: (chunk: Buffer) => void): this;
  on(event: "close", cb: () => void): this;
  on(event: "error", cb: (err: Error) => void): this;
  off?(event: string, cb: (...args: any[]) => void): this;
  removeListener?(event: string, cb: (...args: any[]) => void): this;
}

export interface TransportFactory {
  enumerate(): Promise<PortInfo[]>;
  open(options: {
    path: string;
    baudRate: number;
  }): Promise<SerialPortLike>;
}

export const DEFAULT_BAUD_RATE = 115200;
