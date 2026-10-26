/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Simulated flight controller behind a TransportFactory, for driving the REAL
 * BobFlightCliClient + ProtocolHostAdapter (createHost test seam) + CommandGate
 * with USB-like latency. Replies (Motors tab + storage) follow the persistence
 * audit's motors-race harness. The client's own idle / end-marker framing
 * decides when a reply is complete, exactly as on hardware.
 */
import { EventEmitter } from "node:events";
import type { PortInfo, SerialPortLike, TransportFactory } from "@bobflight/protocol";
import { STORAGE_SCOPE_V13 } from "../../../protocol/src/storage";

export interface FakeFcOptions { rttMs?: number; saveMs?: number }

export class FakeFc {
  rttMs: number; saveMs: number;
  dirty = 0; generation = 3;
  /** Every line the FC received, in order. */
  log: string[] = [];
  /** Lines received while an earlier reply was still pending (must stay 0: one command on the wire). */
  overlaps = 0;
  private pending = 0;
  private holds = new Map<string, Promise<void>>();
  constructor(o: FakeFcOptions = {}) { this.rttMs = o.rttMs ?? 5; this.saveMs = o.saveMs ?? 50; }
  /** The next `cmd` is answered only after release(). */
  hold(cmd: string): () => void {
    let release!: () => void;
    this.holds.set(cmd, new Promise<void>(r => { release = r; }));
    return () => release();
  }
  storageReply(): string {
    return ["storage_api: 1", "backend: flash", "schema: 13", `state: ${this.dirty ? "dirty" : "saved"}`, `dirty: ${this.dirty}`,
      `generation: ${this.generation}`, "last_error: none", `scope: ${STORAGE_SCOPE_V13}`, "armed: 0", "bench_active: 0",
      "calibration_active: 0", "flight_enabled: 0", "storage_end: 1"].join("\r\n") + "\r\n";
  }
  reply(cmd: string): string {
    if (cmd === "version") return "BobFlight 0.1.0-fakefc\r\n";
    if (cmd === "status") return "board: kakute_f7_hdv\r\narm: disarmed\r\nmmio: allowed\r\ndshot_bound: 4/4\r\nmotor_output: DShot300 ready\r\ngyro_ok: yes\r\nfailsafe: ok\r\n";
    if (cmd === "help") return "  motor_pulse <1..4> <0..100>\r\n  motor_test <0..4>\r\n  motor_seq - sequence\r\n  dshot [300|600]\r\n";
    if (cmd === "dshot") return "dshot: 300 kbps\r\n";
    if (/^get erpm_m[1-4]$/.test(cmd)) return `${cmd.slice(4)}=none\r\n`;
    if (/^get dshot_telem_m[1-4]$/.test(cmd)) return "timeout\r\n";
    if (cmd === "storage") return this.storageReply();
    if (cmd === "save") { this.dirty = 0; this.generation++; return "saved: flash verified\r\n"; }
    if (cmd === "get motor_poles") return "motor_poles=14\r\n";
    if (cmd === "set motor_poles 14") { this.dirty = 1; return "motor_poles=14\r\n"; }
    if (cmd === "rpm_filter") return "rpm_filter_api: 1\r\nrpm_filter_end: 1\r\n";
    if (cmd === "get motor_direction") return "motor_direction=props-out\r\n";
    if (cmd === "mixer") return "mixer_api: 1\r\nmixer: quadx\r\nmotor_direction: props-out\r\nmixer_yaw_m1: -1\r\nmixer_yaw_m2: +1\r\nmixer_yaw_m3: +1\r\nmixer_yaw_m4: -1\r\nmixer_end: 1\r\n";
    if (cmd === "motor_test 0") return "motor test accepted (one second maximum)\r\n";
    if (cmd === "disarm") return "disarmed\r\n";
    return "unknown — try help\r\n";
  }
  async handle(cmd: string, emit: (t: string) => void): Promise<void> {
    if (this.pending > 0) this.overlaps++;
    this.pending++;
    this.log.push(cmd);
    try {
      const hold = this.holds.get(cmd);
      if (hold) { this.holds.delete(cmd); await hold; }
      await new Promise(r => setTimeout(r, this.rttMs + (cmd === "save" ? this.saveMs : 0)));
      emit(this.reply(cmd));
    } finally { this.pending--; }
  }
}

class FakeFcPort extends EventEmitter implements SerialPortLike {
  isOpen = false;
  private lineBuf = "";
  constructor(readonly fc: FakeFc, readonly path: string, readonly baudRate: number) { super(); }
  open(): Promise<void> {
    this.isOpen = true;
    setTimeout(() => this.emitData("\r\nBobFlight 0.1.0-fakefc ready\r\n"), 0);
    return Promise.resolve();
  }
  close(): Promise<void> {
    if (!this.isOpen) return Promise.resolve();
    this.isOpen = false; this.emit("close");
    return Promise.resolve();
  }
  write(data: string | Buffer): boolean {
    if (!this.isOpen) return false;
    for (const ch of typeof data === "string" ? data : data.toString("utf8")) {
      if (ch === "\n" || ch === "\r") {
        const line = this.lineBuf.trim(); this.lineBuf = "";
        if (line) void this.fc.handle(line, t => this.emitData(t));
      } else this.lineBuf += ch;
    }
    return true;
  }
  private emitData(text: string): void {
    if (!this.isOpen) return;
    for (let i = 0; i < text.length; i += 64) this.emit("data", Buffer.from(text.slice(i, i + 64), "utf8"));
  }
}

export class FakeFcTransportFactory implements TransportFactory {
  port: FakeFcPort | null = null;
  constructor(readonly fc: FakeFc) {}
  async enumerate(): Promise<PortInfo[]> { return [{ path: "sim://fake-fc", friendlyName: "Fake FC (test)", manufacturer: "BobFlight" }]; }
  async open(o: { path: string; baudRate: number }): Promise<SerialPortLike> {
    this.port = new FakeFcPort(this.fc, o.path, o.baudRate);
    await this.port.open();
    return this.port;
  }
}
