/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Test mocks for the onboard SD download (not exported from the package
 * entry; tests import this file directly):
 *
 * - SparseFat32Card: sparse FAT32 card image. TypeScript port of Robert
 *   Leclercq's SparseCardFixture (tools/test_download_blackbox.py), extended
 *   to several root `BFLxxxxx.BBL` files with arbitrary (fragmented) chains.
 * - MockSdCliFirmware: the FW `sd probe|status|cancel|read` CLI state machine
 *   (bobflight-firmware/src/drivers/sd_cli.h, contract from #42): async read
 *   replies on a later "background poll", the FW's guard/order of checks and
 *   exact lines, plus fault injection (CRC, error lines, silence, stale probe).
 * - SdSimTransportFactory: a SerialPortLike over the FW model so the real
 *   BobFlightCliClient framing/timeouts are exercised (64-byte USB chunks).
 */
import { EventEmitter } from "events";
import type { PortInfo } from "./types";
import type { SerialPortLike, TransportFactory } from "./transport";
import { crc32Ieee, formatCrc32 } from "./sd-read";

const put16 = (b: Uint8Array, o: number, v: number) => { b[o] = v & 0xff; b[o + 1] = (v >>> 8) & 0xff; };
const put32 = (b: Uint8Array, o: number, v: number) => { put16(b, o, v & 0xffff); put16(b, o + 2, (v >>> 16) & 0xffff); };

export interface SparseBblFile {
  name: string;
  size: number;
  /** Cluster chain in file order (fragmented allowed). */
  clusters: number[];
}

export interface SparseCardOptions {
  cardSectors?: number;
  secPerClus?: number;
  fatSz32?: number;
  rsvdSecCnt?: number;
  numFats?: number;
  rootClus?: number;
  partition?: "superfloppy" | "mbr";
  files?: SparseBblFile[];
}

/** Default: 32 GB geometry from the Python fixture (62,333,952 sectors, 16 KiB clusters). */
export class SparseFat32Card {
  readonly cardSectors: number;
  readonly secPerClus: number;
  readonly fatSz32: number;
  readonly rsvdSecCnt: number;
  readonly numFats: number;
  readonly rootClus: number;
  readonly partitionOffset: number;
  readonly fat1Start: number;
  readonly fat2Start: number;
  readonly firstDataSector: number;
  readonly files: SparseBblFile[];
  private sectors = new Map<number, Uint8Array>();
  private payloads = new Map<string, Uint8Array>();

  constructor(o: SparseCardOptions = {}) {
    this.cardSectors = o.cardSectors ?? 62333952;
    this.secPerClus = o.secPerClus ?? 32;
    this.fatSz32 = o.fatSz32 ?? 16384;
    this.rsvdSecCnt = o.rsvdSecCnt ?? 32;
    this.numFats = o.numFats ?? 2;
    this.rootClus = o.rootClus ?? 2;
    this.files = o.files ?? [{ name: "BFL00001.BBL", size: 40116, clusters: [3, 4, 5] }];
    this.partitionOffset = o.partition === "mbr" ? 2048 : 0;
    if (this.partitionOffset) {
      const mbr = this.sector(0);
      mbr[510] = 0x55; mbr[511] = 0xaa;
      mbr[446 + 4] = 0x0c;
      put32(mbr, 446 + 8, this.partitionOffset);
      put32(mbr, 446 + 12, this.cardSectors - this.partitionOffset);
    }
    const vbr = this.sector(this.partitionOffset);
    vbr.set([0xeb, 0x58, 0x90], 0);
    vbr.set([...Array.from("MSWIN4.1")].map((c) => c.charCodeAt(0)), 3);
    put16(vbr, 11, 512); vbr[13] = this.secPerClus; put16(vbr, 14, this.rsvdSecCnt); vbr[16] = this.numFats;
    vbr[21] = 0xf8; put32(vbr, 32, this.cardSectors - this.partitionOffset); put32(vbr, 36, this.fatSz32);
    put32(vbr, 44, this.rootClus);
    vbr.set([...Array.from("FAT32   ")].map((c) => c.charCodeAt(0)), 82);
    vbr[510] = 0x55; vbr[511] = 0xaa;
    this.fat1Start = this.partitionOffset + this.rsvdSecCnt;
    this.fat2Start = this.fat1Start + this.fatSz32;
    this.firstDataSector = this.partitionOffset + this.rsvdSecCnt + this.numFats * this.fatSz32;
    this.setFat(0, 0x0ffffff8);
    this.setFat(1, 0x0fffffff);
    this.setFat(this.rootClus, 0x0fffffff);
    const root = this.sector(this.clusterLba(this.rootClus));
    this.files.forEach((f, idx) => {
      for (let i = 0; i < f.clusters.length; i++) this.setFat(f.clusters[i], i + 1 < f.clusters.length ? f.clusters[i + 1] : 0x0fffffff);
      const o = idx * 32;
      const [base, ext] = f.name.split(".");
      const short = base.padEnd(8, " ") + (ext ?? "").padEnd(3, " ");
      for (let i = 0; i < 11; i++) root[o + i] = short.charCodeAt(i);
      root[o + 11] = 0x20;
      put16(root, o + 20, (f.clusters[0] >>> 16) & 0xffff);
      put16(root, o + 26, f.clusters[0] & 0xffff);
      put32(root, o + 28, f.size);
      const payload = new Uint8Array(f.size);
      for (let i = 0; i < f.size; i++) payload[i] = (i * 13 + 37 + idx * 101) & 0xff;
      this.payloads.set(f.name, payload);
      const clusBytes = this.secPerClus * 512;
      f.clusters.forEach((c, ci) => {
        const chunk = payload.subarray(ci * clusBytes, (ci + 1) * clusBytes);
        for (let s = 0; s * 512 < chunk.length; s++) this.sector(this.clusterLba(c) + s).set(chunk.subarray(s * 512, s * 512 + 512));
      });
    });
  }

  clusterLba(cluster: number): number { return this.firstDataSector + (cluster - 2) * this.secPerClus; }

  /** Writable sector (allocated on demand). */
  sector(lba: number): Uint8Array {
    let s = this.sectors.get(lba);
    if (!s) { s = new Uint8Array(512); this.sectors.set(lba, s); }
    return s;
  }

  setFat(cluster: number, value: number, fats: Array<1 | 2> = this.numFats === 2 ? [1, 2] : [1]): void {
    for (const n of fats) put32(this.sector((n === 1 ? this.fat1Start : this.fat2Start) + Math.floor((cluster * 4) / 512)), (cluster * 4) % 512, value);
  }

  readSector(lba: number): Uint8Array {
    if (lba < 0 || lba >= this.cardSectors) throw new Error(`sector ${lba} out of card bounds`);
    return new Uint8Array(this.sectors.get(lba) ?? new Uint8Array(512));
  }

  payload(name: string): Uint8Array {
    const p = this.payloads.get(name);
    if (!p) throw new Error(`no file ${name}`);
    return p;
  }

  /** LBA holding byte `offset` of a file. */
  fileSectorLba(name: string, offset: number): number {
    const f = this.files.find((x) => x.name === name);
    if (!f) throw new Error(`no file ${name}`);
    const clusBytes = this.secPerClus * 512;
    return this.clusterLba(f.clusters[Math.floor(offset / clusBytes)]) + Math.floor((offset % clusBytes) / 512);
  }
}

/** One-shot behaviour for the next `sd read` of a sector. */
export type SdReadFault =
  /** Correct CRC line, one data byte flipped in transit. */
  | { type: "crc" }
  /** Immediate reply line(s) instead of beginning the read (e.g. `sd_data_error: begin read failed`). */
  | { type: "immediate"; line: string }
  /** The read begins, then this line arrives on a later poll (e.g. `guard check failed`, `driver error`). */
  | { type: "async"; line: string }
  /** The read begins and no reply ever arrives. */
  | { type: "silent" }
  /** Reply for a different sector. */
  | { type: "wrong-sector"; sector: number };

export interface MockSdFirmwareOptions {
  card?: SparseFat32Card | null;
  /** Host build without an SD backend (`no hardware backend in host simulation`). */
  hostSimulation?: boolean;
  armed?: boolean;
  /** `blackbox_cli_busy()`: the recorder owns the card. */
  recorderOwnsCard?: boolean;
  /** Probe already `done` before the session (from before a recording). */
  initialPhase?: "idle" | "done";
  /** The recorder re-initialised the card since the last probe: reads fail with `driver error` until a fresh probe. */
  stale?: boolean;
  /** Probe duration (ms); Infinity = never completes. */
  probeMs?: number;
  /** Delay before a read reply is printed by a background poll (ms). */
  readDelayMs?: number;
  sdIoError?: number;
  /** Omit `sd_sectors` from status (contract violation case). */
  omitSectors?: boolean;
  /** `status` reply lines (arm etc.). */
  statusLines?: string[];
  /** `blackbox status` raw reply. */
  blackboxStatus?: string;
}

const STATES = ["idle", "initializing", "reading-mbr", "reading-boot-sector", "done", "error", "cancelled"] as const;
type Phase = (typeof STATES)[number];

export const MOCK_BLACKBOX_IDLE_STATUS =
  "blackbox_api: 2\r\nblackbox_state: done\r\nblackbox_reason: stopped\r\nblackbox_file: BFL00001.BBL\r\nblackbox_bytes: 40116\r\nblackbox_frames: 650\r\nblackbox_rate_hz: 500\r\nblackbox_dropped: 3731\r\nblackbox_missed: 0\r\nblackbox_invalid: 0\r\nblackbox_queue: 0\r\nblackbox_active: 0\r\nblackbox_rate_requested_hz: 500\r\nblackbox_rate_reason: default\r\nblackbox_drop_pct: 85.2\r\nblackbox_end: 1\r\n";

/** FW `sd` CLI model; `handle()` is called once per received command line. */
export class MockSdCliFirmware {
  card: SparseFat32Card | null;
  hostSimulation: boolean;
  armed: boolean;
  recorderOwnsCard: boolean;
  stale: boolean;
  probeMs: number;
  readDelayMs: number;
  sdIoError: number;
  omitSectors: boolean;
  statusLines: string[];
  blackboxStatus: string;
  phase: Phase;
  cardReady: boolean;
  /** Every command line received, in order. */
  readonly log: string[] = [];
  /** Sectors whose read began, in order. */
  readonly readsStarted: number[] = [];
  /** `sd read` received while another read was still active (pipelining). */
  readsWhileActive = 0;
  maxReadsInFlight = 0;
  private readActive: { sector: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  private probeTimer: ReturnType<typeof setTimeout> | null = null;
  readonly faults = new Map<number, SdReadFault[]>();
  /** Called when a read begins (tests use it to disconnect/cancel/arm mid-read). */
  onReadBegin: ((sector: number) => void) | null = null;

  constructor(o: MockSdFirmwareOptions = {}) {
    this.card = o.card === undefined ? new SparseFat32Card() : o.card;
    this.hostSimulation = !!o.hostSimulation;
    this.armed = !!o.armed;
    this.recorderOwnsCard = !!o.recorderOwnsCard;
    this.stale = !!o.stale;
    this.probeMs = o.probeMs ?? 3;
    this.readDelayMs = o.readDelayMs ?? 1;
    this.sdIoError = o.sdIoError ?? 0;
    this.omitSectors = !!o.omitSectors;
    this.statusLines = o.statusLines ?? ["board: kakute_f7_hdv", "arm: disarmed", "failsafe: ok", "loop_target_hz: 4000", "loop_actual_hz: 3998", "loop_overruns: 12"];
    this.blackboxStatus = o.blackboxStatus ?? MOCK_BLACKBOX_IDLE_STATUS;
    this.phase = o.initialPhase ?? "idle";
    this.cardReady = this.phase === "done" && !!this.card;
  }

  addFault(sector: number, ...faults: SdReadFault[]): void {
    this.faults.set(sector, [...(this.faults.get(sector) ?? []), ...faults]);
  }

  /** A recording cycle since the last probe: the probe still says done, reads then fail with `driver error`. */
  recordingCycle(): void { this.stale = true; }

  get readInFlight(): boolean { return this.readActive !== null; }
  sdCommands(): string[] { return this.log.filter((l) => l.startsWith("sd ")); }

  private guard(): boolean { return !this.armed; }
  private probeBusy(): boolean { return this.phase === "initializing" || this.phase === "reading-mbr" || this.phase === "reading-boot-sector"; }

  private statusText(): string {
    const ready = this.cardReady && this.card;
    const sectors = ready ? this.card!.cardSectors : 0;
    return `sd_api: 1\r\nsd_state: ${this.phase}\r\nsd_detail: ${this.phase === "done" ? "geometry-recognized-not-mounted" : this.phase === "idle" ? "not-probed" : this.phase}\r\n` +
      `sd_capacity_bytes: ${sectors * 512}\r\n${this.omitSectors ? "" : `sd_sectors: ${sectors}\r\n`}sd_partition_lba: ${ready ? this.card!.partitionOffset : 0}\r\n` +
      `sd_filesystem_hint: ${ready ? "FAT32" : "unknown"}\r\nsd_cluster_bytes: ${ready ? this.card!.secPerClus * 512 : 0}\r\nsd_volume_flags: 0\r\nsd_io_error: ${this.sdIoError}\r\n` +
      "sd_write_enabled: no\r\nsd_filesystem_validated: no\r\nsd_end: 1\r\n";
  }

  private cancelRead(): void {
    if (this.readActive?.timer) clearTimeout(this.readActive.timer);
    this.readActive = null;
  }

  /** Handle one trimmed command line; `emit` writes FW output (may be called later for async replies). */
  handle(line: string, emit: (text: string) => void): void {
    this.log.push(line);
    if (line === "status") { emit(this.statusLines.map((l) => `${l}\r\n`).join("")); return; }
    if (line === "blackbox status") { emit(this.blackboxStatus); return; }
    if (line === "version") { emit("BobFlight 0.1.0-sdsim\r\n"); return; }
    const isRead = line.startsWith("sd read") && (line.length === 7 || line[7] === " ");
    if (line !== "sd probe" && line !== "sd status" && line !== "sd cancel" && !isRead) { emit("unknown — try help\r\n"); return; }
    if (this.hostSimulation) {
      emit(isRead ? "sd_data_error: no hardware backend in host simulation\r\nsd_data_end: 1\r\n" : "sd unavailable: no hardware backend in host simulation\r\nsd_write_enabled: no\r\nsd_end: 1\r\n");
      return;
    }
    if (this.recorderOwnsCard) {
      emit(isRead ? "sd_data_error: blackbox busy\r\nsd_data_end: 1\r\n" : "sd unavailable: Blackbox recording owns the card; stop and wait for done\r\nsd_end: 1\r\n");
      return;
    }
    if (this.readActive) {
      if (line === "sd cancel") { this.cancelRead(); this.phase = "cancelled"; emit(this.statusText()); return; }
      if (isRead) { this.readsWhileActive++; emit("sd_data_error: read in progress\r\nsd_data_end: 1\r\n"); return; }
      emit("sd refused: read in progress\r\nsd_end: 1\r\n");
      return;
    }
    if (line === "sd cancel") {
      if (this.probeBusy()) { if (this.probeTimer) clearTimeout(this.probeTimer); this.phase = "cancelled"; }
      emit(this.statusText());
      return;
    }
    if (isRead) { this.beginRead(line, emit); return; }
    if (line === "sd probe") {
      if (!this.guard() || this.probeBusy()) {
        emit("sd refused: disarm, stop motor tests/calibration, connect USB, and wait or cancel the current probe\r\nsd_end: 1\r\n");
        return;
      }
      this.phase = "initializing";
      this.cardReady = false;
      this.stale = false;
      if (Number.isFinite(this.probeMs)) {
        this.probeTimer = setTimeout(() => {
          this.probeTimer = null;
          if (this.phase !== "initializing") return;
          if (this.card) { this.phase = "done"; this.cardReady = true; } else this.phase = "error";
        }, this.probeMs);
      }
    }
    emit(this.statusText());
  }

  private beginRead(line: string, emit: (text: string) => void): void {
    if (!this.guard()) { emit("sd_data_error: disarm, stop motor tests/calibration, connect USB required\r\nsd_data_end: 1\r\n"); return; }
    if (this.phase !== "done" || !this.cardReady || !this.card) { emit("sd_data_error: card not probed or not ready\r\nsd_data_end: 1\r\n"); return; }
    const arg = line.slice(8);
    if (line[7] !== " " || !/^(?:0|[1-9][0-9]*)$/.test(arg) || Number(arg) > 0xffffffff) { emit("sd_data_error: malformed sector argument\r\nsd_data_end: 1\r\n"); return; }
    const sector = Number(arg);
    if (sector >= this.card.cardSectors) { emit("sd_data_error: sector out of bounds\r\nsd_data_end: 1\r\n"); return; }
    const queue = this.faults.get(sector);
    const fault = queue?.shift();
    if (fault?.type === "immediate") { emit(`${fault.line}\r\nsd_data_end: 1\r\n`); return; }
    const card = this.card;
    const active = { sector, timer: null as ReturnType<typeof setTimeout> | null };
    this.readActive = active;
    this.readsStarted.push(sector);
    this.maxReadsInFlight = Math.max(this.maxReadsInFlight, 1);
    this.onReadBegin?.(sector);
    if (fault?.type === "silent" || this.readActive !== active) return;
    active.timer = setTimeout(() => {
      if (this.readActive !== active) return;
      this.readActive = null;
      if (fault?.type === "async") { this.phase = /driver error/.test(fault.line) ? "error" : "cancelled"; emit(`${fault.line}\r\nsd_data_end: 1\r\n`); return; }
      if (this.armed) { this.phase = "cancelled"; emit("sd_data_error: guard check failed\r\nsd_data_end: 1\r\n"); return; }
      if (this.stale) { this.phase = "error"; this.cardReady = false; emit("sd_data_error: driver error\r\nsd_data_end: 1\r\n"); return; }
      const data = card.readSector(sector);
      const crc = formatCrc32(crc32Ieee(data));
      if (fault?.type === "crc") data[100] ^= 0x5a;
      let hex = "";
      for (const b of data) hex += b.toString(16).toUpperCase().padStart(2, "0");
      const shown = fault?.type === "wrong-sector" ? fault.sector : sector;
      // Three writes like the FW (header, hex, footer).
      emit(`sd_data_api: 1\r\nsd_data_sector: ${shown}\r\nsd_data_hex: `);
      emit(hex);
      emit(`\r\nsd_data_crc32: ${crc}\r\nsd_data_end: 1\r\n`);
    }, this.readDelayMs);
  }

  /** Arm while a read is active: the next background poll aborts with `guard check failed`. */
  setArmed(armed: boolean): void { this.armed = armed; }
}

/** SerialPortLike over MockSdCliFirmware; FW output is chunked into 64-byte USB packets. */
export class SdSimPort extends EventEmitter implements SerialPortLike {
  isOpen = false;
  private lineBuf = "";
  constructor(readonly fw: MockSdCliFirmware, readonly path = "sim://bobflight-sd", readonly baudRate = 115200) { super(); }
  open(): Promise<void> {
    this.isOpen = true;
    setTimeout(() => this.emitData("\r\nBobFlight 0.1.0-sdsim ready\r\n"), 0);
    return Promise.resolve();
  }
  close(): Promise<void> {
    if (!this.isOpen) return Promise.resolve();
    this.isOpen = false;
    this.emit("close");
    return Promise.resolve();
  }
  /** Simulated USB unplug: the port closes without the client asking. */
  unplug(): void { void this.close(); }
  write(data: string | Buffer): boolean {
    if (!this.isOpen) return false;
    const text = typeof data === "string" ? data : data.toString("utf8");
    for (const ch of text) {
      if (ch === "\n" || ch === "\r") {
        const line = this.lineBuf.trim();
        this.lineBuf = "";
        if (line) setTimeout(() => { if (this.isOpen) this.fw.handle(line, (t) => this.emitData(t)); }, 0);
      } else this.lineBuf += ch;
    }
    return true;
  }
  private emitData(text: string): void {
    if (!this.isOpen) return;
    for (let i = 0; i < text.length; i += 64) this.emit("data", Buffer.from(text.slice(i, i + 64), "utf8"));
  }
}

export class SdSimTransportFactory implements TransportFactory {
  port: SdSimPort | null = null;
  constructor(readonly fw: MockSdCliFirmware) {}
  async enumerate(): Promise<PortInfo[]> { return [{ path: "sim://bobflight-sd", friendlyName: "SD download simulator", manufacturer: "BobFlight" }]; }
  async open(o: { path: string; baudRate: number }): Promise<SerialPortLike> {
    this.port = new SdSimPort(this.fw, o.path, o.baudRate);
    await this.port.open();
    return this.port;
  }
}
