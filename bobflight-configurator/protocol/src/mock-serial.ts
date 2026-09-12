/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from "events";
import type { PortInfo } from "./types";
import {
  cloneDefaultSettingValues,
  formatFwFloat,
  isSettingsKey,
  parseCliFloat,
  validateSettingValue,
  type SettingsKey,
} from "./settings";

/** Path prefix for MockSerial ports (enumerate + connect). */
export const MOCK_PORT_PATH = "mock://bobflight";

const PRODUCT = "BobFlight";
const VERSION = "0.1.0-skeleton";

export interface MockSerialOptions {
  /** If true, arm succeeds; otherwise FW refuse string. Default false (fail-closed). */
  gyroHealthy?: boolean;
  failsafeActive?: boolean;
  boardId?: string;
}

/**
 * In-process serial that speaks the exact BobFlight FW CLI contract
 * (source: bobflight-firmware/src/drivers/cli.c + flight/config.c).
 */
export class MockSerial extends EventEmitter {
  readonly path: string;
  readonly baudRate: number;
  isOpen = false;

  private lineBuf = "";
  private armed = false;
  private rebootRequested = false;
  /** Numeric store mirroring bf_config_t floats. */
  private settings: Record<SettingsKey, number>;
  private readonly opts: Required<
    Pick<MockSerialOptions, "gyroHealthy" | "failsafeActive" | "boardId">
  >;

  constructor(
    path: string = MOCK_PORT_PATH,
    baudRate = 115200,
    opts: MockSerialOptions = {}
  ) {
    super();
    this.path = path;
    this.baudRate = baudRate;
    this.opts = {
      gyroHealthy: opts.gyroHealthy ?? false,
      failsafeActive: opts.failsafeActive ?? false,
      boardId: opts.boardId ?? "mock-board",
    };
    this.settings = cloneDefaultSettingValues();
  }

  static list(): Promise<PortInfo[]> {
    return Promise.resolve([
      {
        path: MOCK_PORT_PATH,
        manufacturer: "BobFlight",
        friendlyName: "BobFlight Mock CDC",
        serialNumber: "MOCK-001",
      },
    ]);
  }

  open(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    this.isOpen = true;
    this.lineBuf = "";
    this.rebootRequested = false;
    // Fresh session: reset settings store to defaults (disconnect reset).
    this.settings = cloneDefaultSettingValues();
    // cli_init banner — exact contract
    // Defer past attachPort() in BobFlightCliClient.connect (macrotask).
    setTimeout(() => {
      if (!this.isOpen) return;
      this.emitData(`\r\n${PRODUCT} ${VERSION} ready\r\n`);
    }, 0);
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.isOpen) return Promise.resolve();
    this.isOpen = false;
    this.emit("close");
    return Promise.resolve();
  }

  write(data: string | Buffer, encoding?: BufferEncoding): boolean {
    if (!this.isOpen) {
      this.emit("error", new Error("MockSerial is not open"));
      return false;
    }
    const text =
      typeof data === "string"
        ? data
        : data.toString(encoding ?? "utf8");
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") {
        const line = this.lineBuf;
        this.lineBuf = "";
        this.handleLine(line);
      } else {
        this.lineBuf += ch;
      }
    }
    return true;
  }

  private emitData(s: string): void {
    this.emit("data", Buffer.from(s, "utf8"));
  }

  private handleLine(raw: string): void {
    let line = raw;
    while (line.startsWith(" ") || line.startsWith("\t")) {
      line = line.slice(1);
    }
    while (
      line.endsWith(" ") ||
      line.endsWith("\r") ||
      line.endsWith("\n")
    ) {
      line = line.slice(0, -1);
    }
    if (line.length === 0) return;

    if (line === "help") {
      this.emitData(
        "BobFlight CLI\r\n" +
          "  help     - this text\r\n" +
          "  version  - firmware version\r\n" +
          "  status   - MCU, loops, arm, gyro, board\r\n" +
          "  arm      - attempt arm (refuses if gyro unhealthy)\r\n" +
          "  disarm   - disarm\r\n" +
          "  reboot   - soft reset (host: exit loop flag)\r\n" +
          "  get      - get <key>\r\n" +
          "  set      - set <key> <value>\r\n" +
          "  save     - persist settings\r\n" +
          "  defaults - restore defaults (not auto-saved)\r\n"
      );
    } else if (line === "version") {
      this.emitData(`${PRODUCT} ${VERSION}\r\n`);
    } else if (line === "status") {
      const gyroOk = this.opts.gyroHealthy ? "yes" : "no";
      const arm = this.armed ? "armed" : "disarmed";
      const failsafe = this.opts.failsafeActive ? "ACTIVE" : "ok";
      this.emitData(
        `board: ${this.opts.boardId}\r\n` +
          `ir: dummy\r\n` +
          `mcu: mock hse_mhz=8\r\n` +
          `gyro_ok: ${gyroOk}\r\n` +
          `gyro_bind: mock\r\n` +
          `dshot_bound: 0/4\r\n` +
          `rx: none unbound\r\n` +
          `mmio: denied\r\n` +
          `arm: ${arm}\r\n` +
          `failsafe: ${failsafe}\r\n` +
          `loop: gyro=0 Hz denom=1 cascade=0 bg=0\r\n`
      );
    } else if (line === "arm") {
      if (this.opts.gyroHealthy && !this.opts.failsafeActive) {
        this.armed = true;
        this.emitData("armed\r\n");
      } else {
        this.emitData("arm refused (gyro unhealthy or failsafe)\r\n");
      }
    } else if (line === "disarm") {
      this.armed = false;
      this.emitData("disarmed\r\n");
    } else if (line === "reboot") {
      this.emitData("reboot...\r\n");
      this.rebootRequested = true;
      queueMicrotask(() => {
        void this.close();
      });
    } else if (line === "save") {
      // Mock always succeeds (in-memory ack).
      this.emitData("saved\r\n");
    } else if (line === "defaults") {
      this.settings = cloneDefaultSettingValues();
      this.emitData("defaults restored\r\n");
    } else if (line.startsWith("get ") || line === "get") {
      const key = line === "get" ? "" : line.slice(4).trim();
      if (!isSettingsKey(key)) {
        this.emitData("unknown key\r\n");
      } else {
        // snprintf("%s=%.6g\r\n", key, v)
        this.emitData(`${key}=${formatFwFloat(this.settings[key])}\r\n`);
      }
    } else if (line.startsWith("set ") || line === "set") {
      const rest = line === "set" ? "" : line.slice(4).trim();
      const sp = rest.indexOf(" ");
      if (sp <= 0) {
        this.emitData("set failed\r\n");
        return;
      }
      const key = rest.slice(0, sp).trim();
      const valueTok = rest.slice(sp + 1).trim();
      if (!isSettingsKey(key)) {
        this.emitData("unknown key\r\n");
        return;
      }
      const parsed = parseCliFloat(valueTok);
      if (parsed === null) {
        this.emitData("set failed\r\n");
        return;
      }
      if (!validateSettingValue(key, parsed)) {
        this.emitData("set failed\r\n");
        return;
      }
      this.settings[key] = parsed;
      // ok after successful config_set_key + re-get
      this.emitData(`ok ${key}=${formatFwFloat(this.settings[key])}\r\n`);
    } else {
      this.emitData("unknown — try help\r\n");
    }
  }

  /** Test helper: whether reboot was requested (mirrors FW flag). */
  wasRebootRequested(): boolean {
    return this.rebootRequested;
  }

  /** Test helper: snapshot of in-memory settings as FW %.6g strings. */
  getSettingsSnapshot(): Record<SettingsKey, string> {
    const out = {} as Record<SettingsKey, string>;
    for (const key of Object.keys(this.settings) as SettingsKey[]) {
      out[key] = formatFwFloat(this.settings[key]);
    }
    return out;
  }
}
