/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * StoragePanel storage sequences (PR 2), kept free of React so they can be
 * tested on the real CommandGate in Node.
 *
 * - Load (`storage`), Save (`storage` -> `save` -> `storage`) and Export
 *   (`diff all`|`dump all` -> `storage`) each run as ONE gated run
 *   (host.runStorageSequence holds the CommandGate for the whole sequence).
 * - Since the P1 FIFO gate a sequence that finds the gate in use WAITS in the
 *   gate's queue (save at write priority). Gate rejections are recognised by
 *   their stable `code` (isGateBusy / isGateNotSent from the protocol index),
 *   never by message text:
 *   - isGateBusy (GATE_QUEUE_FULL, GATE_BUSY_START): the only case that gets
 *     the bounded retry, and only while nothing of the sequence was sent;
 *   - any other gate rejection (GATE_QUEUE_TIMEOUT, GATE_CANCELLED,
 *     GATE_DISCONNECTED, GATE_SESSION_CHANGED): nothing reached the FC, shown
 *     with the busy text ("nothing sent"), never retried. A cancel the panel
 *     asked for (unmount / revision change / leaving) is silent.
 *   A controller reply, a client error (timeout, port closed mid-reply), a
 *   parse failure or any plain error whose text merely says "busy" is never
 *   retried.
 * - Stop (urgent) is never held behind a storage sequence: the host's gated
 *   run lets waiting urgent commands onto the wire before each of its lines.
 * - Errors keep the controller's own line verbatim; the busy case gets plain
 *   wording plus the raw refusal as a visible detail.
 */
import { parseStorage, parseConfigurationExport, canSaveStorage, isVerifiedFlashSave, StorageReplyError, type StorageSnapshot,
  isGateBusy, isGateNotSent, gateErrorCode, type GatePriority } from "../protocol";
import type { CliCommand, HostCallOptions, StorageSequenceCommand } from "../protocol/types";

/** Gate attempts after the first refusal, and the wait between them: ~3 s in total, then give up. */
export const STORAGE_BUSY_RETRIES = 100;
export const STORAGE_BUSY_RETRY_MS = 30;

export type StorageAction = "refresh" | "save" | "diff" | "dump";
export type StorageSend = (cmd: StorageSequenceCommand) => Promise<string>;

export interface StorageSequenceHost {
  sendCommand(cmd: CliCommand, opts?: HostCallOptions): Promise<string>;
  runStorageSequence?<T>(work: (send: StorageSend) => Promise<T>, opts?: { priority?: GatePriority; signal?: AbortSignal }): Promise<T>;
}

/** The gate stayed busy for the whole retry budget, or rejected the run before it was sent (queue
 * timeout, disconnect drain, session change); nothing reached the FC. `code`: the gate's error code. */
export class StorageBusyError extends Error {
  constructor(readonly action: StorageAction, readonly detail: string, readonly attempts: number, readonly code: string | null = null, readonly linesSent = 0) {
    // Lines of a Save already went out: "nothing was saved" would not be known to be true.
    super(action === "save" && linesSent > 0 ? STORAGE_SAVE_OUTCOME_UNKNOWN_TEXT : STORAGE_BUSY_TEXT[action]);
    this.name = "StorageBusyError";
  }
}
/** The controller answered, but not with the expected confirmation. `reply` is its line(s) verbatim. */
export class StorageControllerError extends Error {
  constructor(message: string, readonly reply: string) { super(message); this.name = "StorageControllerError"; }
}
/** The user left / disconnected while waiting; nothing more is shown. */
export class StorageCancelledError extends Error {
  constructor() { super("storage action cancelled"); this.name = "StorageCancelledError"; }
}

export const STORAGE_BUSY_TEXT: Record<StorageAction, string> = {
  refresh: "Another command was using the connection, so storage status was not read. Nothing was changed. Try Refresh storage again.",
  save: "Another command was using the connection, so nothing was saved. Try Save to controller again.",
  diff: "Another command was using the connection, so nothing was exported. Try again.",
  dump: "Another command was using the connection, so nothing was exported. Try again.",
};

/** A Save stopped by the gate after some of its lines were already sent: the outcome is not known. */
export const STORAGE_SAVE_OUTCOME_UNKNOWN_TEXT = "The save was interrupted after part of it was sent, so the save outcome is unknown. Refresh storage to re-read the controller's status before saving again.";

export interface StorageResult {
  snapshot: StorageSnapshot;
  /** The `storage` reply exactly as received (D1: the accel note reads its `accel_cal_saved:` line). */
  raw: string;
  export?: ReturnType<typeof parseConfigurationExport>;
}

/** `storage` -> snapshot (F5: an unreadable reply is a StorageReplyError with the raw reply). */
export async function loadSequence(send: StorageSend): Promise<StorageSnapshot> {
  return (await readStorage(send)).snapshot;
}

/** `storage` -> snapshot plus the raw reply it was parsed from. */
export async function readStorage(send: StorageSend): Promise<StorageResult> {
  const raw = await send("storage");
  return { snapshot: parseStorage(raw), raw };
}

/** `storage` (save allowed?) -> `save` (verified?) -> `storage` (saved, clean?). */
export async function saveSequence(send: StorageSend, requiredScope?: string): Promise<StorageResult> {
  const before = await loadSequence(send);
  if (!canSaveStorage(before, true, false) || (requiredScope && !before.scope.split(",").includes(requiredScope)))
    throw Error("Flash save unavailable: disarm, stop motors and calibration, and connect firmware that reports controller flash storage. Nothing was saved.");
  const reply = await send("save");
  if (!isVerifiedFlashSave(reply)) throw new StorageControllerError("The controller did not confirm the save. Your settings may not be stored.", reply.trim());
  const read = await readStorage(send), after = read.snapshot;
  if (after.backend !== "flash" || after.state !== "saved" || after.dirty)
    throw new StorageControllerError("The controller replied “saved” but its storage status does not read back as saved.", `state: ${after.state} · dirty: ${after.dirty ? 1 : 0} · backend: ${after.backend}`);
  return read;
}

export async function exportSequence(send: StorageSend, kind: "diff" | "dump"): Promise<StorageResult> {
  const raw = await send(kind === "diff" ? "diff all" : "dump all");
  const data = parseConfigurationExport(raw, kind);
  return { export: data, ...(await readStorage(send)) };
}

export interface GatedOptions {
  retries?: number;
  retryMs?: number;
  /** True once the caller no longer wants the result (tab leave, disconnect): stop retrying. */
  cancelled?: () => boolean;
  sleep?: (ms: number) => Promise<void>;
  /** Abort drops the run while it still waits in the gate queue (unmount / revision change). */
  signal?: AbortSignal;
  /** Told about every gate attempt (tests). */
  onAttempt?: (n: number) => void;
}

/**
 * Runs `work` as one gated storage sequence, retrying only while the gate
 * refuses before anything was sent. Bounded: after `retries` extra attempts a
 * StorageBusyError (plain text + raw refusal) is thrown.
 */
export async function runStorageGated<T>(host: StorageSequenceHost, action: StorageAction, work: (send: StorageSend) => Promise<T>, o: GatedOptions = {}): Promise<T> {
  const retries = o.retries ?? STORAGE_BUSY_RETRIES, retryMs = o.retryMs ?? STORAGE_BUSY_RETRY_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    if (o.cancelled?.() || o.signal?.aborted) throw new StorageCancelledError();
    o.onAttempt?.(attempt + 1);
    let sent = 0;
    // A line counts as sent unless the gate itself rejected it (it never reached the FC).
    const counted = (send: StorageSend): StorageSend => async (cmd) => {
      try { const r = await send(cmd); sent++; return r; } catch (err) { if (!isGateNotSent(err)) sent++; throw err; }
    };
    try {
      // Hosts without a gated sequence (demo host) send line by line; a refusal after a line went out is not retried.
      return host.runStorageSequence
        ? await host.runStorageSequence((send) => work(counted(send)), { priority: action === "save" ? "write" : "normal", signal: o.signal })
        : await work(counted((cmd) => host.sendCommand(cmd, { signal: o.signal })));
    } catch (e) {
      // Not a gate rejection (FC reply, client error, parse failure, or a plain error that only says "busy"): no retry.
      if (!isGateNotSent(e)) throw e;
      const message = e instanceof Error ? e.message : String(e), code = gateErrorCode(e);
      // The panel dropped its own waiting run (unmount, revision change, leaving): nothing more to show.
      if (o.cancelled?.() || o.signal?.aborted) throw new StorageCancelledError();
      // Busy (queue full / refused start) with nothing sent yet: the bounded retry.
      if (isGateBusy(e) && sent === 0 && attempt < retries) { await sleep(retryMs); continue; }
      // Busy after the budget, busy part-way, queue timeout, a cancel or drain it did not ask for, a
      // session change: the gate never sent it. Busy wording ("nothing sent"), no retry.
      throw new StorageBusyError(action, message, attempt + 1, code, sent);
    }
  }
}

/** What the panel shows for a failure: plain text, plus the raw controller/gate line as a visible detail. */
/** `unknown`: a Save was cut off after some lines went out (outcome unknown; the shown status is no longer verified). */
export interface StorageProblem { kind: "busy" | "unknown" | "controller" | "reply" | "other"; text: string; detail?: string }
export function describeStorageError(e: unknown): StorageProblem {
  if (e instanceof StorageBusyError) return { kind: e.action === "save" && e.linesSent > 0 ? "unknown" : "busy", text: e.message, detail: `${e.linesSent === 0 ? "Nothing was sent to the controller." : "The rest of the sequence was not sent."} Connection reply: ${e.detail}` };
  if (e instanceof StorageControllerError) return { kind: "controller", text: e.message, detail: `Controller reply: ${e.reply}` };
  if (e instanceof StorageReplyError) return { kind: "reply", text: "The controller’s storage reply could not be read, so storage status is unknown.", detail: `${e.message}. Controller reply: ${e.raw.trim() || "(empty)"}` };
  return { kind: "other", text: e instanceof Error ? e.message : String(e) };
}
