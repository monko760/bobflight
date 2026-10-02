/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Integrated onboard SD log download (BB2a). Frozen FW sequence (#42) on every
 * list and every download: fresh `sd probe` -> `sd status` until done (15 s
 * cap; sd_sectors present, sd_io_error 0) -> one `sd read <N>` at a time
 * (protocol SdSectorReader through the shared CommandGate) -> `sd cancel`.
 *
 * Never saves a corrupted file: a CRC mismatch is retried once for that sector,
 * then the download aborts naming the sector. The Blob is created only after
 * every sector of the file verified and the length equals the directory entry.
 * FW error/refusal lines are kept verbatim for display. Cancel, tab leave and
 * disconnect abort cleanly: partial data is dropped and `sd cancel` is sent
 * whenever the link is still connected.
 */
import {
  Fat32RootReader,
  SD_PROBE_ACTIVE_STATES,
  SD_PROBE_TIMEOUT_MS,
  parseSdStatusReply,
  sdReadyCapacity,
  type Fat32BblEntry,
  type SdReadResult,
  type SdStatusResult,
} from '@bobflight/protocol';

export type SdDownloadCommand = 'sd probe' | 'sd status' | 'sd cancel';
export interface SdDownloadLink {
  getConnectionStatus(): string;
  sendCommand(cmd: SdDownloadCommand): Promise<string>;
  readSdSector?(sector: number): Promise<SdReadResult>;
}
export type SdDownloadPhase = 'idle' | 'probing' | 'scanning' | 'downloading' | 'cancelling';
export type SdCancelReason = 'user' | 'left-tab' | 'disconnected' | 'blocked';
export interface SdDownloadProgress {
  file: string;
  bytesTotal: number;
  bytesDone: number;
  sectorsTotal: number;
  sectorsDone: number;
  /** Measured from real timings of completed sector reads; null before the first sector. */
  bytesPerSecond: number | null;
}
export interface SdDownloadMessage {
  tone: 'info' | 'ok' | 'error';
  text: string;
  /** FW line exactly as sent (error/refusal), or null. */
  fwLine: string | null;
}
export interface SdDownloadOptions {
  /** Hands the verified file to the browser (Blob download). */
  save(name: string, blob: Blob): void;
  now?: () => number;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
  /** How long to retry while another UI command holds the gate (nothing is sent meanwhile). */
  gateRetryMs?: number;
  onChange?: () => void;
}

/** Why Download / List are disabled, or null. FW still enforces its own locks. */
export function downloadBlockedReason(s: { connected: boolean; postFlashGate: boolean; recording: boolean; armed: boolean; storageBlocked: boolean; supported: boolean }): string | null {
  if (!s.connected) return 'Connect to the controller to download logs from its SD card.';
  if (s.postFlashGate) return 'Complete the post-flash connection checks before downloading logs.';
  if (!s.supported) return 'This connection cannot read SD sectors.';
  if (s.recording) return 'Onboard recording owns the SD card: stop recording and wait for done before downloading.';
  if (s.armed) return 'Disarm before downloading logs from the SD card.';
  if (s.storageBlocked) return 'Finish the SD card check or USB bench recording before downloading.';
  return null;
}

class Abort extends Error {
  constructor(readonly text: string, readonly fwLine: string | null = null, readonly tone: 'error' | 'info' = 'error') { super(text); }
}

const NOTHING_SAVED = 'Nothing was saved.';
const isGateBusy = (e: unknown) => /request not queued/.test(e instanceof Error ? e.message : String(e));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export class SdDownloadController {
  phase: SdDownloadPhase = 'idle';
  files: Fat32BblEntry[] | null = null;
  progress: SdDownloadProgress | null = null;
  message: SdDownloadMessage | null = null;
  /** Sector reads sent in the current/last operation (tests and diagnostics). */
  sectorReads = 0;
  private cancelReason: SdCancelReason | null = null;
  private readonly now: () => number;
  private readonly probeTimeoutMs: number;
  private readonly pollIntervalMs: number;
  private readonly gateRetryMs: number;

  constructor(private link: SdDownloadLink, private opts: SdDownloadOptions) {
    this.now = opts.now ?? (() => performance.now());
    this.probeTimeoutMs = opts.probeTimeoutMs ?? SD_PROBE_TIMEOUT_MS;
    this.pollIntervalMs = opts.pollIntervalMs ?? 150;
    this.gateRetryMs = opts.gateRetryMs ?? 2500;
  }

  get busy(): boolean { return this.phase !== 'idle'; }
  get supported(): boolean { return typeof this.link.readSdSector === 'function'; }

  private changed() { this.opts.onChange?.(); }
  private connected() { return this.link.getConnectionStatus() === 'connected'; }

  /** Request an abort; the running operation stops after the in-flight reply and sends `sd cancel` if connected. */
  cancel(reason: SdCancelReason = 'user'): void {
    if (!this.busy || this.cancelReason) return;
    this.cancelReason = reason;
    this.phase = 'cancelling';
    this.changed();
  }

  private cancelText(reason: SdCancelReason, what: string): string {
    switch (reason) {
      case 'user': return `${what} cancelled.`;
      case 'left-tab': return `${what} stopped because you left the Blackbox tab.`;
      case 'disconnected': return `${what} stopped: the USB connection closed.`;
      case 'blocked': return `${what} stopped: post-flash connection checks are required.`;
    }
  }

  /** Cancel/tab-leave requested: stop (the reply that just arrived is discarded). */
  private checkCancel(what: string): void {
    if (this.cancelReason) throw new Abort(this.cancelText(this.cancelReason, what), null, 'info');
  }

  private check(what: string): void {
    this.checkCancel(what);
    if (!this.connected()) throw new Abort(this.cancelText('disconnected', what), null, 'info');
  }

  private sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

  private async withGate<T>(what: string, work: () => Promise<T>): Promise<T> {
    const deadline = this.now() + this.gateRetryMs;
    for (;;) {
      try { return await work(); } catch (e) {
        if (isGateBusy(e) && this.now() < deadline && !this.cancelReason) { await this.sleep(40); continue; }
        if (!this.connected()) throw new Abort(this.cancelText('disconnected', what), null, 'info');
        throw e;
      }
    }
  }

  private async sendSd(cmd: 'sd probe' | 'sd status', what: string): Promise<Extract<SdStatusResult, { kind: 'status' }>> {
    let raw: string;
    try { raw = await this.withGate(what, () => this.link.sendCommand(cmd)); } catch (e) {
      if (e instanceof Abort) throw e;
      throw new Abort(`${cmd} failed: ${errText(e)}. ${NOTHING_SAVED}`);
    }
    this.check(what);
    const st = parseSdStatusReply(raw);
    if (st.kind === 'refused') throw new Abort(`The flight controller refused ${cmd}. ${NOTHING_SAVED}`, st.line);
    if (st.kind === 'malformed') throw new Abort(`Unexpected reply to ${cmd}: ${st.reason}. ${NOTHING_SAVED}`);
    return st;
  }

  /** Fresh probe, poll to done, mount FAT32 over CRC-verified sector reads. */
  private async openVolume(what: string): Promise<Fat32RootReader> {
    this.phase = 'probing'; this.changed();
    const started = this.now();
    const probe = await this.sendSd('sd probe', what);
    if (!(SD_PROBE_ACTIVE_STATES as readonly string[]).includes(probe.state) && probe.state !== 'done') {
      throw new Abort(`The SD probe did not start (sd_detail: ${probe.detail ?? 'not reported'}). ${NOTHING_SAVED}`, `sd_state: ${probe.state}`);
    }
    let sectors = 0;
    for (;;) {
      if (this.now() - started >= this.probeTimeoutMs) {
        throw new Abort(`The card did not reach sd_state: done within ${this.probeTimeoutMs / 1000} s of the probe. ${NOTHING_SAVED}`);
      }
      await this.sleep(this.pollIntervalMs);
      this.check(what);
      const st = await this.sendSd('sd status', what);
      if ((SD_PROBE_ACTIVE_STATES as readonly string[]).includes(st.state)) continue;
      if (st.state !== 'done') throw new Abort(`The SD probe ended without a readable card (sd_detail: ${st.detail ?? 'not reported'}). ${NOTHING_SAVED}`, `sd_state: ${st.state}`);
      const cap = sdReadyCapacity(st);
      if (!cap.ok) throw new Abort(`The card is not ready for reading: ${cap.reason}. ${NOTHING_SAVED}`);
      if (st.filesystem !== null && st.filesystem !== 'FAT32') {
        throw new Abort(`The card reports sd_filesystem_hint: ${st.filesystem}. Only FAT32 cards can be read here; use an SD card reader. ${NOTHING_SAVED}`);
      }
      sectors = cap.sectors;
      break;
    }
    this.phase = 'scanning'; this.changed();
    const fs = new Fat32RootReader((lba) => this.readVerified(lba, what), sectors);
    await this.fat(() => fs.mount());
    return fs;
  }

  private async fat<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (e) {
      if (e instanceof Abort) throw e;
      throw new Abort(`The card cannot be read safely: ${errText(e)}. ${NOTHING_SAVED}`);
    }
  }

  private async readOnce(lba: number, what: string): Promise<SdReadResult> {
    const read = this.link.readSdSector;
    if (!read) throw new Abort('This connection cannot read SD sectors.');
    try {
      this.sectorReads++;
      return await this.withGate(what, () => read.call(this.link, lba));
    } catch (e) {
      if (e instanceof Abort) throw e;
      throw new Abort(`sd read ${lba} failed: ${errText(e)}. ${NOTHING_SAVED}`);
    }
  }

  /** One sector, CRC verified; a CRC mismatch is retried exactly once. */
  private async readVerified(lba: number, what: string): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      this.check(what);
      const r = await this.readOnce(lba, what);
      this.checkCancel(what); // a reply that arrives after Cancel/tab leave is discarded
      switch (r.kind) {
        case 'data': return r.bytes;
        case 'crc-mismatch':
          if (attempt === 0) continue;
          throw new Abort(`CRC mismatch on sector ${lba} (FC sent ${r.sentCrc}, data computes to ${r.actualCrc}) after one retry. Download aborted. ${NOTHING_SAVED}`);
        case 'error': throw new Abort(`The flight controller stopped the read of sector ${lba}. ${NOTHING_SAVED}`, r.line);
        case 'refused': throw new Abort(`The flight controller refused sd read ${lba}. ${NOTHING_SAVED}`, r.line);
        case 'timeout': throw new Abort(`No reply to sd read ${lba} within ${r.timeoutMs / 1000} s. ${NOTHING_SAVED}`);
        case 'malformed': throw new Abort(`Invalid reply to sd read ${lba}: ${r.reason}. ${NOTHING_SAVED}`);
      }
    }
  }

  /** `sd cancel` at the end of every sequence (success or abort) while connected. */
  private async endSession(): Promise<string> {
    if (!this.connected()) return ' sd cancel was not sent (not connected).';
    try {
      const raw = await this.withGate('Download', () => this.link.sendCommand('sd cancel'));
      const st = parseSdStatusReply(raw);
      return st.kind === 'refused' ? ` Sent sd cancel; the controller replied: ${st.line}` : ' Sent sd cancel.';
    } catch (e) {
      return ` sd cancel could not be sent: ${errText(e)}.`;
    }
  }

  private begin(): boolean {
    if (this.busy || !this.connected() || !this.supported) return false;
    this.cancelReason = null;
    this.message = null;
    this.progress = null;
    this.sectorReads = 0;
    return true;
  }

  private async fail(e: unknown): Promise<void> {
    const abort = e instanceof Abort ? e : new Abort(`Download failed: ${errText(e)}. ${NOTHING_SAVED}`);
    this.progress = null; // partial data is discarded with the operation's buffers
    const cancelNote = await this.endSession();
    this.message = { tone: abort.tone, text: abort.text + (abort.tone === 'info' ? ` Partial data was discarded.${cancelNote}` : cancelNote), fwLine: abort.fwLine };
  }

  private finish(): void {
    this.phase = 'idle';
    this.cancelReason = null;
    this.changed();
  }

  /** Probe, then list BFL*.BBL files (with sizes) from the FAT32 root. */
  async list(): Promise<boolean> {
    if (!this.begin()) return false;
    this.files = null;
    try {
      const fs = await this.openVolume('Listing');
      const files = await this.fat(() => fs.listBblFiles());
      this.check('Listing');
      const note = await this.endSession();
      this.files = files;
      this.message = { tone: 'ok', text: `${files.length ? `Found ${files.length} log file${files.length === 1 ? '' : 's'}` : 'No BFLxxxxx.BBL log files'} in the card root.${note}`, fwLine: null };
      return true;
    } catch (e) {
      await this.fail(e);
      return false;
    } finally {
      this.finish();
    }
  }

  /** Fresh probe, re-read the root entry, read and verify every sector, then save. */
  async download(name: string): Promise<boolean> {
    if (!this.begin()) return false;
    const listed = this.files?.find((f) => f.name === name) ?? null;
    let data: Uint8Array<ArrayBuffer> | null = null;
    try {
      const fs = await this.openVolume('Download');
      const entry = (await this.fat(() => fs.listBblFiles())).find((f) => f.name === name);
      if (!entry) throw new Abort(`${name} is no longer in the card root; list the card again. ${NOTHING_SAVED}`);
      if (listed && listed.size !== entry.size) throw new Abort(`${name} changed since it was listed (${listed.size} to ${entry.size} bytes); list the card again. ${NOTHING_SAVED}`);
      const lbas = await this.fat(() => fs.fileDataSectors(entry));
      this.phase = 'downloading';
      this.progress = { file: name, bytesTotal: entry.size, bytesDone: 0, sectorsTotal: lbas.length, sectorsDone: 0, bytesPerSecond: null };
      this.changed();
      const buf = new Uint8Array(lbas.length * 512);
      const t0 = this.now();
      for (let i = 0; i < lbas.length; i++) {
        buf.set(await this.readVerified(lbas[i], 'Download'), i * 512);
        const done = Math.min((i + 1) * 512, entry.size);
        const elapsed = this.now() - t0;
        this.progress = { ...this.progress, bytesDone: done, sectorsDone: i + 1, bytesPerSecond: elapsed > 0 ? (done * 1000) / elapsed : null };
        this.changed();
      }
      data = buf.subarray(0, entry.size);
      if (data.length !== entry.size) throw new Abort(`Read ${data.length} bytes but the directory entry says ${entry.size}. ${NOTHING_SAVED}`);
      this.check('Download');
      const note = await this.endSession();
      if (this.cancelReason) throw new Abort(this.cancelText(this.cancelReason, 'Download'), null, 'info');
      const blob = new Blob([data], { type: 'application/octet-stream' });
      if (blob.size !== entry.size) throw new Abort(`Assembled ${blob.size} bytes but the directory entry says ${entry.size}. ${NOTHING_SAVED}`);
      this.opts.save(name, blob);
      this.message = { tone: 'ok', text: `Saved ${name}: ${entry.size.toLocaleString('en-US')} bytes, ${lbas.length} sectors CRC-verified.${note}`, fwLine: null };
      return true;
    } catch (e) {
      data = null;
      await this.fail(e);
      return false;
    } finally {
      this.finish();
    }
  }
}

/** "12.3 KiB/s" style rate, or "measuring…" before the first sector. */
export function formatRate(bps: number | null): string {
  if (bps === null || !Number.isFinite(bps)) return 'measuring…';
  return bps >= 1024 ? `${(bps / 1024).toFixed(1)} KiB/s` : `${Math.round(bps)} B/s`;
}
