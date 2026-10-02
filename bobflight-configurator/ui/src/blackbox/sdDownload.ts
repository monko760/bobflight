/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Integrated onboard SD log download (BB2a). Frozen FW sequence (#42) on every
 * list and every download: fresh `sd probe` -> `sd status` until done (15 s
 * cap; sd_sectors present, sd_io_error 0) -> `blackbox status` and `status`
 * re-read (refuse while recording or armed; a real reply that does not say is
 * allowed and shown as "Recorder state unknown" / "Arm state unknown"; a reply
 * that never arrives aborts) -> one `sd read <N>` at a time (protocol
 * SdSectorReader through the shared CommandGate) -> `sd cancel`, sent and
 * reported only when an SD command actually went out.
 *
 * Never saves a corrupted file: a CRC mismatch is retried once for that sector,
 * then the download aborts naming the sector. The Blob is created only after
 * every sector of the file verified and the length equals the directory entry.
 * FW error/refusal lines are kept verbatim for display. Cancel, tab leave and
 * disconnect abort cleanly: partial data is dropped and `sd cancel` is sent
 * whenever the link is still connected. A timeout resets the USB link (client
 * policy for an unterminated framed reply): the user is told to reconnect.
 * FW refusals are recognised by their `sd refused:` / `sd unavailable:` prefix
 * only (protocol parser) and shown as the full line.
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
import { ONBOARD_ACTIVE_STATES, parseOnboardReply } from './onboard';

export type SdDownloadCommand = 'sd probe' | 'sd status' | 'sd cancel' | 'blackbox status' | 'status';
export interface SdDownloadLink {
  getConnectionStatus(): string;
  sendCommand(cmd: SdDownloadCommand): Promise<string>;
  readSdSector?(sector: number): Promise<SdReadResult>;
  /** Host-wide settings storage action in flight (save, defaults, storage refresh). */
  storageActionPending?(): boolean;
}
export type SdDownloadPhase = 'idle' | 'probing' | 'scanning' | 'downloading' | 'cancelling';
export type SdCancelReason = 'user' | 'left-tab' | 'disconnected' | 'blocked';
export interface SdDownloadProgress {
  file: string;
  bytesTotal: number;
  bytesDone: number;
  sectorsTotal: number;
  sectorsDone: number;
}
export interface SdDownloadMessage {
  tone: 'info' | 'ok' | 'error';
  text: string;
  /** FW line exactly as sent (error/refusal), or null. */
  fwLine: string | null;
  /** Raw technical detail (e.g. the internal error line) shown small but visible, or null. */
  detail?: string | null;
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

/**
 * What holds the storage lock on the Blackbox tab: a settings storage action
 * in flight on any page (save, defaults, StoragePanel refresh), the SD card
 * check, or the USB bench recorder.
 */
export type SdStorageBlock = false | 'settings' | 'sd-check' | 'bench-recorder';

export const STORAGE_BLOCK_TEXT: Record<Exclude<SdStorageBlock, false>, string> = {
  settings: 'A settings storage action (save, defaults or storage refresh) is in progress: wait for it to finish before downloading.',
  'sd-check': 'Finish the SD card check before downloading.',
  'bench-recorder': 'Stop the USB bench recording before downloading.',
};

/** The page's storage lock, first holder wins. */
export function storageBlock(s: { settingsPending: boolean; sdCheckBusy: boolean; benchRecording: boolean }): SdStorageBlock {
  if (s.settingsPending) return 'settings';
  if (s.sdCheckBusy) return 'sd-check';
  if (s.benchRecording) return 'bench-recorder';
  return false;
}

/** Why Download / List are disabled, or null. FW still enforces its own locks. */
export function downloadBlockedReason(s: { connected: boolean; postFlashGate: boolean; recording: boolean; armed: boolean; storageBlocked: SdStorageBlock; supported: boolean }): string | null {
  if (!s.connected) return 'Connect to the controller to download logs from its SD card.';
  if (s.postFlashGate) return 'Complete the post-flash connection checks before downloading logs.';
  if (!s.supported) return 'This connection cannot read SD sectors.';
  if (s.recording) return 'Onboard recording owns the SD card: stop recording and wait for done before downloading.';
  if (s.armed) return 'Disarm before downloading logs from the SD card.';
  if (s.storageBlocked) return STORAGE_BLOCK_TEXT[s.storageBlocked];
  return null;
}

/** Shown (visible) when the pre-read `blackbox status` reply arrived but gave no usable recorder state. */
export const RECORDER_STATE_UNKNOWN =
  "Recorder state unknown: the controller's blackbox status reply did not report a recorder state (older firmware?). The download relies on the controller's own SD card lock.";

/** Shown (visible) when the pre-read `status` reply arrived without `arm: armed` / `arm: disarmed`. */
export const ARM_STATE_UNKNOWN =
  "Arm state unknown: the controller's status reply did not report arm: armed or arm: disarmed, so the Configurator's arm lock is inactive. The flight controller's own guard still refuses SD reads while armed.";

/** Plain text when the shared connection stayed busy (CommandGate refused) past the retry window. */
export const GATE_BUSY_TEXT = 'Another command was using the connection; nothing was read. Try again.';
export const GATE_BUSY_MID_READ_TEXT = 'Another command was using the connection, so the download stopped. Nothing was saved. Try again.';

export type ArmVerdict = { kind: 'disarmed' } | { kind: 'armed'; line: string } | { kind: 'unknown' };

/** Arm state from a real `status` reply: `arm: armed` refuses (any such line wins), `arm: disarmed` passes, else unknown. */
export function armVerdict(raw: string): ArmVerdict {
  const lines = raw.split(/\r\n|\n|\r/).map((l) => l.trim()).filter((l) => /^arm:/.test(l));
  const values = lines.map((l) => l.replace(/^arm:\s*/, ''));
  const armed = lines.find((_, i) => values[i] === 'armed');
  if (armed !== undefined) return { kind: 'armed', line: armed };
  if (values.length > 0 && values.every((v) => v === 'disarmed')) return { kind: 'disarmed' };
  return { kind: 'unknown' };
}

export type RecorderVerdict = { kind: 'idle' } | { kind: 'recording'; line: string } | { kind: 'unknown' };

/**
 * Recorder state from a `blackbox status` reply. A strict reply decides; an
 * unreadable one still refuses on any sign of an active session
 * (`blackbox_active: 1` or an active state); otherwise the state is unknown.
 */
export function recorderVerdict(raw: string): RecorderVerdict {
  const lines = raw.split(/\r\n|\n|\r/).map((l) => l.trim());
  const stateLine = lines.find((l) => /^blackbox_state:/.test(l)) ?? null;
  const activeLine = lines.find((l) => /^blackbox_active:/.test(l)) ?? null;
  const recording = (): RecorderVerdict => ({ kind: 'recording', line: stateLine ?? activeLine ?? 'blackbox_active: 1' });
  try {
    const snap = parseOnboardReply(raw);
    if (!snap.unavailable) return snap.active ? recording() : { kind: 'idle' };
  } catch { /* fall through: fail safe below */ }
  const state = stateLine?.replace(/^blackbox_state:\s*/, '') ?? '';
  const active = activeLine?.replace(/^blackbox_active:\s*/, '') ?? '';
  if (active === '1' || (ONBOARD_ACTIVE_STATES as readonly string[]).includes(state)) return recording();
  return { kind: 'unknown' };
}

class Abort extends Error {
  constructor(readonly text: string, readonly fwLine: string | null = null, readonly tone: 'error' | 'info' = 'error', readonly detail: string | null = null) { super(text); }
}
/** The CommandGate stayed busy past the retry window: nothing was sent for this step. */
class GateBusyAbort extends Abort {
  constructor(raw: string) { super(GATE_BUSY_TEXT, null, 'error', raw); }
}
/** A command timed out; the text depends on whether the client reset the USB link. */
class TimeoutAbort extends Abort {
  constructor(readonly what: string, readonly detail: string) { super(`${what} timed out (${detail}).`); }
}

const NOTHING_SAVED = 'Nothing was saved.';
const isGateBusy = (e: unknown) => /request not queued/.test(e instanceof Error ? e.message : String(e));
/** The gate dropped the request because the USB session changed: it was never written. */
const isSessionChanged = (e: unknown) => /USB session changed/.test(e instanceof Error ? e.message : String(e));
const isTimeoutError = (e: unknown) => /terminator missing|timed out/.test(e instanceof Error ? e.message : String(e));
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export class SdDownloadController {
  phase: SdDownloadPhase = 'idle';
  files: Fat32BblEntry[] | null = null;
  progress: SdDownloadProgress | null = null;
  message: SdDownloadMessage | null = null;
  /** RECORDER_STATE_UNKNOWN when the last pre-read `blackbox status` reply gave no usable state, else null. */
  recorderNote: string | null = null;
  /** ARM_STATE_UNKNOWN when the last pre-read `status` reply gave no arm state, else null. */
  armNote: string | null = null;
  /** Visible problems found in the card root (e.g. a BFL-named subdirectory). */
  warnings: string[] = [];
  /** Sector reads sent in the current/last operation (tests and diagnostics). */
  sectorReads = 0;
  /** Sector reads that returned a reply (any kind) in the current operation. */
  private sectorsAnswered = 0;
  /** True once an SD command of the current operation was handed to the link (not refused by the gate). */
  private sdOnWire = false;
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

  /**
   * Runs one command through the shared CommandGate, retrying for gateRetryMs
   * while another command holds it (nothing is sent meanwhile). `sd` marks SD
   * commands: once one was handed to the link (not refused by the gate) the
   * operation ends with `sd cancel`. `cancellable` is false only for that
   * closing `sd cancel`, which still waits for the gate after a user Cancel.
   */
  private async withGate<T>(what: string, work: () => Promise<T>, sd = false, cancellable = true): Promise<T> {
    const deadline = this.now() + this.gateRetryMs;
    for (;;) {
      try {
        const r = await work();
        if (sd) this.sdOnWire = true;
        return r;
      } catch (e) {
        const notSent = isGateBusy(e) || isSessionChanged(e);
        if (sd && !notSent) this.sdOnWire = true;
        if (isGateBusy(e) && this.now() < deadline && !(cancellable && this.cancelReason)) { await this.sleep(40); continue; }
        // Cancel/tab leave while waiting on a busy gate: the cancel text, not the busy text.
        if (isGateBusy(e) && cancellable) this.checkCancel(what);
        if (isTimeoutError(e)) throw new TimeoutAbort(what, `no complete reply: ${errText(e)}`);
        if (!this.connected()) throw new Abort(this.cancelText('disconnected', what), null, 'info');
        if (isGateBusy(e)) throw new GateBusyAbort(errText(e));
        throw e;
      }
    }
  }

  private async sendSd(cmd: 'sd probe' | 'sd status', what: string): Promise<Extract<SdStatusResult, { kind: 'status' }>> {
    let raw: string;
    try { raw = await this.withGate(what, () => this.link.sendCommand(cmd), true); } catch (e) {
      if (e instanceof Abort) throw e;
      throw new Abort(`${cmd} failed. ${NOTHING_SAVED}`, null, 'error', errText(e));
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
        throw new Abort(
          `This card is not FAT32 (sd_filesystem_hint: ${st.filesystem}). Only FAT32 cards can be read over USB here; take the card out and copy the logs with an SD card reader. ${NOTHING_SAVED}`,
          `sd_filesystem_hint: ${st.filesystem}`,
        );
      }
      sectors = cap.sectors;
      break;
    }
    await this.checkLocks(what);
    this.phase = 'scanning'; this.changed();
    const fs = new Fat32RootReader((lba) => this.readVerified(lba, what), sectors);
    await this.fat(() => fs.mount());
    return fs;
  }

  /**
   * A real reply to a lock re-read. Anything else (gate still busy, USB session
   * changed, timeout, client error, disconnect) aborts visibly before any sd
   * read: a missing reply is never treated as "state unknown".
   */
  private async lockReply(cmd: 'blackbox status' | 'status', what: string): Promise<string> {
    try { return await this.withGate(what, () => this.link.sendCommand(cmd)); } catch (e) {
      if (e instanceof Abort) throw e;
      throw new Abort(`${cmd} could not be read, so the recorder and arm locks were not checked. No sd read was sent. ${NOTHING_SAVED}`, null, 'error', errText(e));
    }
  }

  /**
   * Re-read `blackbox status` and `status` right before any sd read: refuse
   * while recording or armed. A real reply that does not report the state is
   * allowed (the FW guard applies) and shown as a visible note.
   */
  private async checkLocks(what: string): Promise<void> {
    const bb = await this.lockReply('blackbox status', what);
    this.check(what);
    const rec = recorderVerdict(bb);
    if (rec.kind === 'recording') {
      throw new Abort(`Onboard recording is active, so the recorder owns the SD card: stop recording and wait for done, then try again. No sd read was sent. ${NOTHING_SAVED}`, rec.line);
    }
    const st = await this.lockReply('status', what);
    this.check(what);
    const arm = armVerdict(st);
    if (arm.kind === 'armed') {
      throw new Abort(`The flight controller reports it is armed: disarm, then try again. No sd read was sent. ${NOTHING_SAVED}`, arm.line);
    }
    this.recorderNote = rec.kind === 'unknown' ? RECORDER_STATE_UNKNOWN : null;
    this.armNote = arm.kind === 'unknown' ? ARM_STATE_UNKNOWN : null;
    this.changed();
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
      const r = await this.withGate(what, () => read.call(this.link, lba), true);
      this.sectorsAnswered++;
      return r;
    } catch (e) {
      if (e instanceof GateBusyAbort && this.sectorsAnswered > 0) throw new Abort(GATE_BUSY_MID_READ_TEXT, null, 'error', e.detail);
      if (e instanceof Abort) throw e;
      throw new Abort(`sd read ${lba} failed. ${NOTHING_SAVED}`, null, 'error', errText(e));
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
        case 'timeout': throw new TimeoutAbort(what, `no reply to sd read ${lba} within ${r.timeoutMs / 1000} s`);
        case 'malformed': throw new Abort(`Invalid reply to sd read ${lba}: ${r.reason}. ${NOTHING_SAVED}`);
      }
    }
  }

  /**
   * `sd cancel` at the end of every sequence (success or abort) while
   * connected, but only if an SD command of this operation actually went out:
   * otherwise there is nothing to cancel and nothing is claimed.
   */
  private async endSession(): Promise<string> {
    if (!this.sdOnWire) return '';
    if (!this.connected()) return ' sd cancel was not sent (not connected).';
    try {
      const raw = await this.withGate('Download', () => this.link.sendCommand('sd cancel'), false, false);
      const st = parseSdStatusReply(raw);
      return st.kind === 'refused' ? ` Sent sd cancel; the controller replied: ${st.line}` : ' Sent sd cancel.';
    } catch (e) {
      return e instanceof GateBusyAbort
        ? ' sd cancel could not be sent: another command was using the connection.'
        : ` sd cancel could not be sent: ${errText(e)}.`;
    }
  }

  private begin(): boolean {
    if (this.busy || !this.connected() || !this.supported) return false;
    this.cancelReason = null;
    this.message = null;
    this.progress = null;
    this.sectorReads = 0;
    this.sectorsAnswered = 0;
    this.sdOnWire = false;
    this.recorderNote = null;
    this.armNote = null;
    if (this.link.storageActionPending?.()) {
      this.message = { tone: 'error', text: `${STORAGE_BLOCK_TEXT.settings} Nothing was sent.`, fwLine: null };
      this.changed();
      return false;
    }
    return true;
  }

  /** The client drops the link after an unterminated framed reply; wait briefly for that before wording the message. */
  private async timeoutText(t: TimeoutAbort): Promise<string> {
    const end = this.now() + 1000;
    while (this.connected() && this.now() < end) await this.sleep(20);
    const subject = t.what === 'Download' ? 'The download' : 'Listing the card';
    const again = t.what === 'Download' ? 'download again' : 'list the card again';
    return this.connected()
      ? `${subject} timed out (${t.detail}). Try again: ${again}. ${NOTHING_SAVED}`
      : `${subject} timed out (${t.detail}) and the USB link was reset. Reconnect, then ${again}. ${NOTHING_SAVED}`;
  }

  private async fail(e: unknown): Promise<void> {
    const abort = e instanceof Abort ? e : new Abort(`Download failed. ${NOTHING_SAVED}`, null, 'error', errText(e));
    this.progress = null; // partial data is discarded with the operation's buffers
    const text = abort instanceof TimeoutAbort ? await this.timeoutText(abort) : abort.text;
    const cancelNote = await this.endSession();
    this.message = { tone: abort.tone, text: text + (abort.tone === 'info' ? ` Partial data was discarded.${cancelNote}` : cancelNote), fwLine: abort.fwLine, detail: abort.detail };
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
    this.warnings = [];
    try {
      const fs = await this.openVolume('Listing');
      const files = await this.fat(() => fs.listBblFiles());
      this.check('Listing');
      const note = await this.endSession();
      this.files = files;
      this.warnings = fs.bblSubdirectories.map((n) => `${n} in the card root is a subdirectory, not a log file: it is not listed and cannot be downloaded here. Check the card with an SD card reader.`);
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
      this.progress = { file: name, bytesTotal: entry.size, bytesDone: 0, sectorsTotal: lbas.length, sectorsDone: 0 };
      this.changed();
      const buf = new Uint8Array(lbas.length * 512);
      for (let i = 0; i < lbas.length; i++) {
        buf.set(await this.readVerified(lbas[i], 'Download'), i * 512);
        this.progress = { ...this.progress, bytesDone: Math.min((i + 1) * 512, entry.size), sectorsDone: i + 1 };
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
