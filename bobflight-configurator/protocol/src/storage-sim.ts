/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Test-only FW model for the settings `storage` / `save` CLI (StoragePanel PR 2).
 *
 * Wire shapes follow the firmware's storage_cli.h:
 *   `storage` -> storage_api: 1 ... storage_end: 1 (schema 13, full scope)
 *   `save`    -> `saved: <backend> verified` or `save failed: <last_error>`
 * `power` follows cli.c cmd_power (a healthy 4S pack, no current sensor).
 * Every other line goes to the protocol MockSerial (receiver, power, sensors,
 * ports, modes, status, ...), so pages render against one simulated FC. A
 * settings-changing line marks storage dirty, as on the FC.
 */
import { EventEmitter } from "node:events";
import type { PortInfo } from "./types";
import type { SerialPortLike, TransportFactory } from "./transport";
import { MockSerial, type MockSerialOptions } from "./mock-serial";
import { STORAGE_SCOPE_V13 } from "./storage";
import { mockSensorReply } from "./sensor-mock";

export interface StorageSimOptions {
  backend?: "flash" | "host_sim" | "unsupported";
  armed?: boolean;
  benchActive?: boolean;
  calibrationActive?: boolean;
  /** Delay before the `save` reply (flash write time), ms. */
  saveMs?: number;
  /** Delay before the `storage` reply, ms. */
  storageMs?: number;
  mock?: MockSerialOptions;
  /**
   * Simulated live IMU for page tests: `sensors` answers the MockSerial shape
   * with an advancing sample_seq, a 1 ms sample age, gyro_ok and attitude_ready.
   * Off by default (the offline mock never invents fresh samples).
   */
  liveSensors?: boolean;
}

/** Lines the FC treats as settings changes (storage goes dirty). */
const MUTATING = /^(?:set |receiver_uart |receiver_map |power_config |mode_range |control_source |control_mode |dshot |defaults$|calibrate_accel apply$)/;

export class MockStorageFirmware {
  backend: "flash" | "host_sim" | "unsupported";
  state: "saved" | "dirty" | "defaults" | "error" | "unsupported";
  generation = 1;
  lastError = "none";
  armed: boolean;
  benchActive: boolean;
  calibrationActive: boolean;
  saveMs: number;
  storageMs: number;
  /** Every line received, in order. */
  readonly log: string[] = [];
  /** One-shot reply overrides, consumed in order: the next time `line` arrives, reply with this text instead (null = no reply at all). */
  readonly replyOnce = new Map<string, Array<string | null>>();
  /** Next `save` fails with `save failed: <token>` (FW persist_last_error). */
  failNextSave: string | null = null;
  /** Called when a line arrives (before its reply). */
  onLine: ((line: string) => void) | null = null;
  /** Called synchronously right after a sim-owned reply (storage/save/power/override) was delivered to the host. */
  afterReply: ((line: string) => void) | null = null;
  readonly mockOptions: MockSerialOptions;
  liveSensors: boolean;
  private sampleSeq = 0;

  constructor(o: StorageSimOptions = {}) {
    this.backend = o.backend ?? "flash";
    this.state = this.backend === "unsupported" ? "unsupported" : "saved";
    this.armed = !!o.armed;
    this.benchActive = !!o.benchActive;
    this.calibrationActive = !!o.calibrationActive;
    this.saveMs = o.saveMs ?? 5;
    this.storageMs = o.storageMs ?? 1;
    this.mockOptions = o.mock ?? {};
    this.liveSensors = !!o.liveSensors;
  }

  /** Live-IMU `sensors` reply (simulation only; see StorageSimOptions.liveSensors). */
  sensorsReply(): string {
    const seq = ++this.sampleSeq;
    return (mockSensorReply("sensors", this.armed) ?? "")
      .replace("sample_seq: 0", `sample_seq: ${seq}`).replace("sample_ms: 0", `sample_ms: ${seq * 2}`)
      .replace("sensor_age_ms: 4294967295", "sensor_age_ms: 1").replace("gyro_ok: no", "gyro_ok: yes")
      .replace("attitude_ready: no", "attitude_ready: yes").replace("accel_g: 0 0 0", "accel_g: 0 0 1")
      .replace("accel_raw_g: 0 0 0", "accel_raw_g: 0 0 1").replace("sensor_config_ok: no", "sensor_config_ok: yes");
  }

  get dirty(): boolean { return this.state === "dirty"; }
  markDirty(): void { if (this.backend !== "unsupported") this.state = "dirty"; }
  count(line: string): number { return this.log.filter((l) => l === line).length; }

  storageReply(): string {
    return [
      "storage_api: 1", `backend: ${this.backend}`, "schema: 13", `state: ${this.state}`, `dirty: ${this.dirty ? 1 : 0}`,
      `generation: ${this.generation}`, `last_error: ${this.lastError}`, `scope: ${STORAGE_SCOPE_V13}`,
      `armed: ${this.armed ? 1 : 0}`, `bench_active: ${this.benchActive ? 1 : 0}`, `calibration_active: ${this.calibrationActive ? 1 : 0}`,
      "flight_enabled: 0", "storage_end: 1",
    ].join("\r\n") + "\r\n";
  }

  /** `power` report shaped as cli.c cmd_power. */
  powerReply(): string {
    return [
      "power_api: 1", "valid: 1", "present: 1", "current_valid: 0", "consumption_valid: 0",
      "voltage: 16.400", "amps: 0.000", "consumed_mah: 0.000", "warning: ok",
      "voltage_scale: 11", "current_mv_per_amp: 0", "current_offset_mv: 0",
      "cells: 4", "warning_cell_v: 3.500", "critical_cell_v: 3.300", "capacity_mah: 1300",
      "raw_voltage: 1830", "raw_current: 0", `persistence: ${this.backend}`, "power_end: 1",
    ].join("\r\n") + "\r\n";
  }

  /** `save` exactly as storage_cli.h: verified on success, `save failed: <last_error>` otherwise. */
  saveReply(): string {
    if (this.failNextSave !== null) { this.lastError = this.failNextSave; this.failNextSave = null; this.state = "error"; return `save failed: ${this.lastError}\r\n`; }
    if (this.backend === "unsupported") { this.lastError = "unsupported"; return "save failed: unsupported\r\n"; }
    this.generation++; this.state = "saved"; this.lastError = "none";
    return `saved: ${this.backend} verified\r\n`;
  }
}

class StorageSimPort extends EventEmitter implements SerialPortLike {
  isOpen = false;
  private buf = "";
  private readonly inner: MockSerial;
  constructor(private readonly fw: MockStorageFirmware, readonly path: string, readonly baudRate: number) {
    super();
    this.inner = new MockSerial("mock://bobflight", baudRate, fw.mockOptions);
    this.inner.on("data", (d: Buffer) => { if (this.isOpen) this.emit("data", d); });
  }
  async open(): Promise<void> { await this.inner.open(); this.isOpen = true; }
  async close(): Promise<void> { if (!this.isOpen) return; this.isOpen = false; await this.inner.close(); this.emit("close"); }
  write(data: string | Buffer): boolean {
    if (!this.isOpen) return false;
    const text = typeof data === "string" ? data : data.toString("utf8");
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") { const line = this.buf.trim(); this.buf = ""; if (line) this.line(line); }
      else this.buf += ch;
    }
    return true;
  }
  private reply(line: string, text: string, ms: number): void {
    setTimeout(() => { if (!this.isOpen) return; this.emit("data", Buffer.from(text, "utf8")); this.fw.afterReply?.(line); }, ms);
  }
  private line(line: string): void {
    const fw = this.fw;
    fw.log.push(line);
    fw.onLine?.(line);
    const once = fw.replyOnce.get(line);
    if (once?.length) { const text = once.shift()!; if (!once.length) fw.replyOnce.delete(line); if (text !== null) this.reply(line, text, 1); return; }
    if (line === "storage") { this.reply(line, fw.storageReply(), fw.storageMs); return; }
    if (line === "save") { const r = fw.saveReply(); this.reply(line, r, fw.saveMs); return; }
    if (line === "power") { this.reply(line, fw.powerReply(), 1); return; }
    if (line === "sensors" && fw.liveSensors) { this.reply(line, fw.sensorsReply(), 1); return; }
    if (MUTATING.test(line)) fw.markDirty();
    this.inner.write(`${line}\r\n`);
  }
}

/** Opens a StorageSimPort over one MockStorageFirmware (one simulated FC). */
export class StorageSimTransportFactory implements TransportFactory {
  port: StorageSimPort | null = null;
  constructor(readonly fw: MockStorageFirmware) {}
  async enumerate(): Promise<PortInfo[]> { return [{ path: "sim://bobflight-storage", friendlyName: "Storage simulator", manufacturer: "BobFlight" }]; }
  async open(o: { path: string; baudRate: number }): Promise<SerialPortLike> {
    this.port = new StorageSimPort(this.fw, o.path, o.baudRate);
    await this.port.open();
    return this.port;
  }
}
