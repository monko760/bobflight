import { MockPortsModes } from "./ports-modes-mock";
/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from "events";
import { MockMotorBench } from "./bench-mock";
import { mockSensorReply } from "./sensor-mock";
import { MockReceiver } from "./receiver-mock";
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
  /** Explicit simulation only; default output-unavailable mock stays fail closed. */
  benchReady?: boolean;
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
  private bench: MockMotorBench;
  private modesPorts = new MockPortsModes();
  private receiver = new MockReceiver();
  private armed = false;
  private rebootRequested = false;
  /** R0b RAM-only bidir flag (default off). */
  private dshotBidir = false;
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
    this.bench = new MockMotorBench(opts.benchReady ?? false);
    this.path = path;
    this.baudRate = baudRate;
    this.opts = {
      gyroHealthy: opts.gyroHealthy ?? false,
      failsafeActive: opts.failsafeActive ?? false,
      boardId: opts.boardId ?? "mock-board",
    };
    this.modesPorts.reset();
    this.dshotBidir = false;
    this.settings = cloneDefaultSettingValues();
  }

  static list(): Promise<PortInfo[]> {
    return Promise.resolve([
      {
        path: MOCK_PORT_PATH,
        manufacturer: "BobFlight",
        friendlyName: "BobFlight Mock CDC (outputs unavailable)",
        serialNumber: "MOCK-001",
      },
      { path: "mock://bobflight-bench", manufacturer: "BobFlight", friendlyName: "Motor bench demo — SIMULATED", serialNumber: "MOCK-BENCH" },
    ]);
  }

  open(): Promise<void> {
    if (this.isOpen) return Promise.resolve();
    this.isOpen = true;
    this.lineBuf = "";
    this.bench.reset();
    this.armed = false;
    this.rebootRequested = false;
    // Fresh session: reset settings store to defaults (disconnect reset).
    this.modesPorts.reset();
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
    this.bench.disconnect();
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
    if(line === "bl" || line === "bl discard"){this.emitData("bl unavailable: mock transport has no ROM bootloader\r\n");return;}
    if(line === "pid_diag" || line.startsWith("pid_diag ")){this.emitData("pid_diag_available: no\r\nreason: mock-no-hardware\r\nmotor_output: disabled\r\npid_diag_end: 1\r\n");return;}
    if(line === "blackbox start" || line === "blackbox stop" || line === "blackbox status"){this.emitData("blackbox unavailable: mock has no physical SD card\r\nblackbox_end: 1\r\n");return;}
    if(line.startsWith("sd read")){this.emitData("sd_data_error: unavailable-mock\r\nsd_data_end: 1\r\n");return;}
    if(line === "sd probe" || line === "sd status" || line === "sd cancel"){this.emitData("sd_state: unavailable-mock\r\nsd_write_enabled: no\r\nsd_end: 1\r\n");return;}
    if(line === "timing"){this.emitData("timing_available: no\r\ntimebase: mock-no-hardware\r\ntiming_end: 1\r\n");return;}
    const pm = this.modesPorts.handle(line,this.armed,this.bench.active);
    if(pm!==null){this.emitData(pm);return;}
    const sensorReply = mockSensorReply(line, this.armed);
    if (sensorReply !== null) { this.emitData(sensorReply); return; }
    const benchReply = this.bench.handle(line, this.armed);
    if (line==="reboot") this.receiver.reset();
    const receiverReply = this.receiver.handle(line,this.armed,this.bench.active);
    if(receiverReply!==null) { this.emitData(receiverReply);return; }
    if (benchReply !== null) { this.emitData(benchReply); return; }

    if (line === "help") {
      this.emitData(
        "BobFlight CLI\r\n" + this.bench.help +
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
          `dshot_bound: ${this.bench.ready ? "4/4" : "0/4"}\r\n` +
          `motor_output: ${this.bench.ready ? "DShot300 ready" : "unavailable"}\r\n` +
          `rx: none unbound\r\n` +
          `mmio: ${this.bench.ready ? "allowed (simulated)" : "denied"}\r\n` +
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
      this.modesPorts.reset();
    this.settings = cloneDefaultSettingValues();
      this.emitData("defaults restored\r\n");
    } else if (line.startsWith("get ") || line === "get") {
      const key = line === "get" ? "" : line.slice(4).trim();
      // R0b: M1 live-capable mock; M2–4 unknown until FW R0c (honest).
      if (key === "erpm_m1") {
        if (this.dshotBidir) {
          // Sample eRPM when bidir on — not a fake idle 0 while unavailable.
          this.emitData("erpm_m1=24600\r\n");
        } else {
          this.emitData("erpm_m1=none\r\n");
        }
        return;
      }
      if (/^erpm_m[2-4]$/.test(key)) {
        this.emitData("unknown key\r\n");
        return;
      }
      if (key === "dshot_telem_m1") {
        // FW returns status token only (no key= prefix) for telem.
        this.emitData(this.dshotBidir ? "ok\r\n" : "none\r\n");
        return;
      }
      if (/^dshot_telem_m[2-4]$/.test(key)) {
        this.emitData("unknown key\r\n");
        return;
      }
      if (key === "dshot_bidir") {
        this.emitData(this.dshotBidir ? "dshot_bidir=on\r\n" : "dshot_bidir=off\r\n");
        return;
      }
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
      if (key === "dshot_bidir") {
        if (valueTok === "on") {
          this.dshotBidir = true;
          this.emitData("ok dshot_bidir=on\r\n");
        } else if (valueTok === "off") {
          this.dshotBidir = false;
          this.emitData("ok dshot_bidir=off\r\n");
        } else {
          this.emitData("set failed\r\n");
        }
        return;
      }
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
