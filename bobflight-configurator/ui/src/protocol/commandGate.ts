/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * CommandGate: the one shared path from every UI page to the FC's USB CLI.
 *
 * Exactly one command is on the wire at a time (framing and idle rules are the
 * client's, unchanged). Since P1 (persistence audit, fix 1 of 5) a command that
 * arrives while another is running WAITS in a short bounded priority FIFO
 * instead of being refused:
 *
 *   urgent  — Stop / disarm (`motor_test 0`, `bench_stop`, `disarm`). Always
 *             accepted (never counted against the bound), no queue timeout,
 *             ahead of everything else that is waiting.
 *   write   — `save`, `defaults`, `set …` (settings mutations). Ahead of reads.
 *   normal  — everything else (status, get, storage, polls, exports …).
 *
 * Within one class the order is strictly FIFO (never reordered). The running
 * command is never pre-empted.
 *
 * - Bound: at most GATE_QUEUE_LIMIT non-urgent commands wait. One more is
 *   refused with the gate's existing busy error (isGateBusy() stays true,
 *   message "busy, queue full: …; request not queued"), never dropped silently.
 * - Timeout: each queued command has its own deadline measured from enqueue
 *   (default GATE_QUEUE_TIMEOUT_MS). A command still waiting then is removed and
 *   rejected (GateQueueTimeoutError); it never reached the FC. Once on the wire
 *   the client's own response timeout applies.
 * - Cancel: an AbortSignal passed by the caller (unmount, tab leave) drops the
 *   command from the queue (GateCancelledError). A command already on the wire
 *   cannot be recalled and settles normally.
 * - Disconnect: drain("disconnected") rejects everything still waiting with
 *   "disconnected". A command that was queued in one USB session is never sent
 *   in another (session generation check at dispatch, as before).
 * - Motor starts are NEVER queued (safety, unchanged since the bench was added):
 *   `arm`, `motor_test 1..4`, `motor_pulse …`, `motor_seq` run only on an idle
 *   gate and are otherwise refused with the busy error, so a start can never
 *   fire late after the user's preflight.
 */

/** Overflow / start refusal: raised before `work` runs, so nothing reached the FC. Kept matching
 * the pre-queue busy wording ("another UI command is in flight", "request not queued") so older
 * callers that pattern-match it stay honest. */
export const GATE_BUSY_MESSAGE = "busy, queue full: another UI command is in flight; request not queued";
/** A motor start found the gate busy: starts are never queued. Same busy error type. */
export const GATE_START_BUSY_MESSAGE = "busy: another UI command is in flight; motor start request not queued";
export const GATE_DISCONNECTED_MESSAGE = "disconnected";
export const GATE_CANCELLED_MESSAGE = "cancelled before it was sent; request dropped from the command queue";
export const GATE_SESSION_CHANGED_MESSAGE = "USB session changed; request cancelled";
/** Waiting (not running) non-urgent commands allowed at once. */
export const GATE_QUEUE_LIMIT = 16;
/** Default per-command wait limit from enqueue to dispatch. */
export const GATE_QUEUE_TIMEOUT_MS = 5000;

/** The gate's busy refusal (overflow or a refused motor start). Nothing was sent. */
export class GateBusyError extends Error {
  constructor(message: string = GATE_BUSY_MESSAGE) { super(message); this.name = "GateBusyError"; }
}
/** A queued command was still waiting when its own deadline expired. Nothing was sent. */
export class GateQueueTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`timed out after ${timeoutMs} ms waiting in the command queue; request not sent`);
    this.name = "GateQueueTimeoutError";
  }
}
/** The caller cancelled (AbortSignal) while the command was still queued. Nothing was sent. */
export class GateCancelledError extends Error {
  constructor() { super(GATE_CANCELLED_MESSAGE); this.name = "GateCancelledError"; }
}

/** True only for the gate's own busy refusal (overflow / refused start), never for an FC reply or transport error. */
export function isGateBusy(e: unknown): boolean {
  return e instanceof GateBusyError || (e instanceof Error && (e.message === GATE_BUSY_MESSAGE || e.message === GATE_START_BUSY_MESSAGE));
}
/** True when the gate rejected the command before it reached the FC (busy, queue timeout, cancel, disconnect, session change). */
export function isGateNotSent(e: unknown): boolean {
  return isGateBusy(e) || e instanceof GateQueueTimeoutError || e instanceof GateCancelledError ||
    (e instanceof Error && (e.message === GATE_DISCONNECTED_MESSAGE || e.message === GATE_SESSION_CHANGED_MESSAGE));
}

export type GatePriority = "urgent" | "write" | "normal";
const RANK: Record<GatePriority, number> = { urgent: 0, write: 1, normal: 2 };

export interface GateRunOptions {
  /** Default "normal". */
  priority?: GatePriority;
  /** Run only on an idle gate (empty queue, nothing on the wire); otherwise refuse with the busy error. */
  exclusive?: boolean;
  /** Abort drops the command while it is still queued. */
  signal?: AbortSignal;
  /** Max wait from enqueue to dispatch. Default GATE_QUEUE_TIMEOUT_MS; urgent defaults to no limit. */
  timeoutMs?: number;
}

/** Gate class for one exact CLI line (used by the host adapter's sendCommand). */
export function commandGateOptions(cmd: string): GateRunOptions {
  if (cmd === "motor_test 0" || cmd === "bench_stop" || cmd === "disarm") return { priority: "urgent" };
  if (cmd === "arm" || cmd === "motor_seq" || /^motor_test [1-4]$/.test(cmd) || cmd.startsWith("motor_pulse ")) return { exclusive: true };
  if (cmd === "save" || cmd === "defaults" || cmd.startsWith("set ")) return { priority: "write" };
  return { priority: "normal" };
}

interface Entry {
  work: () => Promise<unknown>; rank: number; urgent: boolean; generation: number;
  resolve: (v: unknown) => void; reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>; signal?: AbortSignal; onAbort?: () => void;
}

export class CommandGate {
  private running = false;
  private queue: Entry[] = [];
  constructor(private session: () => number, private readonly limit = GATE_QUEUE_LIMIT,
    private readonly queueTimeoutMs = GATE_QUEUE_TIMEOUT_MS) {}

  /** Commands waiting (not yet on the wire). */
  get queued(): number { return this.queue.length; }
  /** True while a command is on the wire. */
  get busy(): boolean { return this.running; }

  /** `opts === true` is the legacy Stop flag (urgent). */
  run<T>(work: () => Promise<T>, opts: boolean | GateRunOptions = {}): Promise<T> {
    const o: GateRunOptions = typeof opts === "boolean" ? { priority: opts ? "urgent" : "normal" } : opts;
    const priority = o.priority ?? "normal";
    const urgent = priority === "urgent";
    if (o.signal?.aborted) return Promise.reject(new GateCancelledError());
    if (o.exclusive && (this.running || this.queue.length > 0)) return Promise.reject(new GateBusyError(GATE_START_BUSY_MESSAGE));
    if (!urgent && (this.running || this.queue.length > 0) && this.queue.filter(e => !e.urgent).length >= this.limit) return Promise.reject(new GateBusyError(GATE_BUSY_MESSAGE));
    return new Promise<T>((resolve, reject) => {
      const entry: Entry = { work, rank: RANK[priority], urgent, generation: this.session(),
        resolve: resolve as (v: unknown) => void, reject };
      // Stable insert: after every waiting command of the same or a higher class.
      let i = this.queue.findIndex(e => e.rank > entry.rank);
      if (i < 0) i = this.queue.length;
      this.queue.splice(i, 0, entry);
      const timeoutMs = o.timeoutMs ?? (urgent ? Infinity : this.queueTimeoutMs);
      if (Number.isFinite(timeoutMs)) {
        entry.timer = setTimeout(() => { if (this.remove(entry)) reject(new GateQueueTimeoutError(timeoutMs)); }, Math.max(0, timeoutMs));
      }
      if (o.signal) {
        entry.signal = o.signal;
        entry.onAbort = () => { if (this.remove(entry)) reject(new GateCancelledError()); };
        o.signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pump();
    });
  }

  /** Reject every waiting command (the one on the wire settles on its own). */
  drain(message = GATE_DISCONNECTED_MESSAGE): void {
    const waiting = this.queue.splice(0);
    for (const e of waiting) { this.cleanup(e); e.reject(new Error(message)); }
  }

  private cleanup(e: Entry): void {
    if (e.timer !== undefined) clearTimeout(e.timer);
    if (e.signal && e.onAbort) e.signal.removeEventListener("abort", e.onAbort);
  }
  private remove(e: Entry): boolean {
    const i = this.queue.indexOf(e);
    if (i < 0) return false;
    this.queue.splice(i, 1);
    this.cleanup(e);
    return true;
  }
  private pump(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.cleanup(next);
    if (next.generation !== this.session()) {
      next.reject(new Error(GATE_SESSION_CHANGED_MESSAGE));
      this.pump();
      return;
    }
    this.running = true;
    // Dispatch on a microtask, like the pre-queue gate (work never runs inside run()).
    // The gate frees (and the next waiting command is taken) before the caller sees its result.
    const settle = (fn: () => void) => { this.running = false; this.pump(); fn(); };
    Promise.resolve().then(() => next.work()).then(
      (v) => settle(() => next.resolve(v)),
      (e) => settle(() => next.reject(e)));
  }
}
