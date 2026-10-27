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
 *   `arm`, `motor_test 1..4`, `motor_pulse …`, `motor_seq` and `bench_switch`
 *   (it arms the props-off AUX switch session that runs motors) run only on an
 *   idle gate and are otherwise refused with the busy error ("busy, try again"),
 *   so a start can never fire late after the user's preflight.
 * - Urgent inside a compound entry (review round 1): a host call that sends
 *   several lines as ONE gate entry (getAllSettings = 30 gets, restoreDefaults,
 *   saveSettings) calls the `yieldToUrgent` hook the gate passes to `work`
 *   before each of its lines. Waiting urgent commands (Stop) go on the wire
 *   there, right after the reply currently on the wire. Nothing else
 *   interleaves, and still only one line is on the wire at a time.
 *
 * Classes for CLI lines (commandGateOptions): an explicit READ list is normal;
 * every other line (set, save, defaults, dshot <rate>, receiver_uart,
 * receiver_map, power_config, calibrate_*, mode_range, control_*, blackbox
 * start/stop, pid_diag start/stop, sd cancel, reboot, bl …) changes FC state
 * and is write class, so a later save can never overtake it. Unknown lines
 * default to write (fail-safe ordering).
 *
 * Errors: every gate rejection carries a stable `code` (GateErrorCode). Callers
 * use the predicates (isGateBusy / isGateNotSent / gateErrorCode), never the
 * message text, which is UI copy and may change.
 */

/** Stable codes on every gate rejection. Match on these (or the predicates), never on message text. */
export type GateErrorCode =
  | "GATE_QUEUE_FULL"       // overflow: 16 non-urgent commands already waiting
  | "GATE_BUSY_START"       // motor start / bench_switch found the gate busy (starts are never queued)
  | "GATE_QUEUE_TIMEOUT"    // waited past its own deadline from enqueue
  | "GATE_CANCELLED"        // caller's AbortSignal fired while it was queued
  | "GATE_DISCONNECTED"     // drained on disconnect while queued
  | "GATE_SESSION_CHANGED"; // queued in an earlier USB session
export const GATE_ERROR_CODES: readonly GateErrorCode[] = [
  "GATE_QUEUE_FULL", "GATE_BUSY_START", "GATE_QUEUE_TIMEOUT", "GATE_CANCELLED", "GATE_DISCONNECTED", "GATE_SESSION_CHANGED",
];

/** Overflow refusal: raised before `work` runs, so nothing reached the FC. UI copy only (match `code`). */
export const GATE_BUSY_MESSAGE = "busy, queue full: another UI command is in flight; request not queued";
/** A motor start (or bench_switch) found the gate busy: starts are never queued. Same GateBusyError type. */
export const GATE_START_BUSY_MESSAGE = "busy, try again: another UI command is in flight; motor start request not queued";
export const GATE_DISCONNECTED_MESSAGE = "disconnected";
export const GATE_CANCELLED_MESSAGE = "cancelled before it was sent; request dropped from the command queue";
export const GATE_SESSION_CHANGED_MESSAGE = "USB session changed; request cancelled";
/** Waiting (not running) non-urgent commands allowed at once. */
export const GATE_QUEUE_LIMIT = 16;
/** Default per-command wait limit from enqueue to dispatch (never applied to urgent). */
export const GATE_QUEUE_TIMEOUT_MS = 5000;

/** Base of every gate rejection: nothing reached the FC. */
export class GateError extends Error {
  readonly gate = true as const;
  constructor(readonly code: GateErrorCode, message: string) { super(message); this.name = "GateError"; }
}
/** The gate's busy refusal: overflow (GATE_QUEUE_FULL) or a refused motor start (GATE_BUSY_START). */
export class GateBusyError extends GateError {
  constructor(message: string = GATE_BUSY_MESSAGE, code: "GATE_QUEUE_FULL" | "GATE_BUSY_START" = message === GATE_START_BUSY_MESSAGE ? "GATE_BUSY_START" : "GATE_QUEUE_FULL") {
    super(code, message); this.name = "GateBusyError";
  }
}
/** A queued command was still waiting when its own deadline expired. */
export class GateQueueTimeoutError extends GateError {
  constructor(readonly timeoutMs: number) {
    super("GATE_QUEUE_TIMEOUT", `timed out after ${timeoutMs} ms waiting in the command queue; request not sent`);
    this.name = "GateQueueTimeoutError";
  }
}
/** The caller cancelled (AbortSignal) while the command was still queued. */
export class GateCancelledError extends GateError {
  constructor() { super("GATE_CANCELLED", GATE_CANCELLED_MESSAGE); this.name = "GateCancelledError"; }
}
/** drain(): the USB connection went away while the command was queued. */
export class GateDisconnectedError extends GateError {
  constructor(message: string = GATE_DISCONNECTED_MESSAGE) { super("GATE_DISCONNECTED", message); this.name = "GateDisconnectedError"; }
}
/** Queued in one USB session, dispatched in another: dropped. */
export class GateSessionChangedError extends GateError {
  constructor() { super("GATE_SESSION_CHANGED", GATE_SESSION_CHANGED_MESSAGE); this.name = "GateSessionChangedError"; }
}

/** The stable code of a gate rejection, or null for anything else (FC reply, transport, client timeout). */
export function gateErrorCode(e: unknown): GateErrorCode | null {
  const code = (e as { code?: unknown } | null)?.code;
  return e instanceof Error && (e as { gate?: unknown }).gate === true && typeof code === "string" && (GATE_ERROR_CODES as readonly string[]).includes(code)
    ? code as GateErrorCode : null;
}
/** Busy refusal: queue full OR a motor start / bench_switch refused on a busy gate. "Try again later" may help. */
export function isGateBusy(e: unknown): boolean {
  const c = gateErrorCode(e);
  return c === "GATE_QUEUE_FULL" || c === "GATE_BUSY_START";
}
/** Any gate rejection: the command never reached the FC (busy refusals, queue timeout, cancel,
 * disconnect drain, session change). Such an error says nothing about the FC or its firmware, so
 * it must never be shown as "older firmware", "malformed" or an FC failure. A command that WAS sent
 * and then failed (client timeout, FC reply, port closed mid-reply) is never "not sent". */
export function isGateNotSent(e: unknown): boolean {
  return gateErrorCode(e) !== null;
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
  /** Max wait from enqueue to dispatch. Default GATE_QUEUE_TIMEOUT_MS; urgent never times out in the queue. */
  timeoutMs?: number;
}

/** Passed to the running entry's `work`: a compound entry awaits it before each line it sends so
 * waiting urgent commands go on the wire first. A no-op when nothing urgent is waiting. */
export type YieldToUrgent = () => Promise<void>;

const READ_EXACT = new Set<string>([
  "help", "ports", "modes", "storage", "diff all", "dump all", "version", "sd probe", "sd status",
  "blackbox status", "status", "receiver", "pid_diag", "pid_diag status", "timing", "power", "bench_status",
  "barometer", "flash_info", "sensors", "calibration", "dshot", "loop_rate", "mixer", "rpm_filter", "filters",
]);
/** True for CLI lines that only read FC state (normal class). */
export function isReadOnlyCliCommand(cmd: string): boolean {
  return READ_EXACT.has(cmd) || /^get [a-z0-9_]+$/.test(cmd) || /^sd read \d+$/.test(cmd);
}
/** True for the motor-start lines that are never queued. */
export function isMotorStartCommand(cmd: string): boolean {
  return cmd === "arm" || cmd === "motor_seq" || cmd === "bench_switch" || /^motor_test [1-4]$/.test(cmd) || cmd.startsWith("motor_pulse ");
}

/** Gate class for one exact CLI line (used by the host adapter's sendCommand). */
export function commandGateOptions(cmd: string): GateRunOptions {
  if (cmd === "motor_test 0" || cmd === "bench_stop" || cmd === "disarm") return { priority: "urgent" };
  if (isMotorStartCommand(cmd)) return { exclusive: true };
  if (isReadOnlyCliCommand(cmd)) return { priority: "normal" };
  // save, defaults, set …, and every other state-changing line: ordered with the writes.
  return { priority: "write" };
}

interface Entry {
  work: (yieldToUrgent: YieldToUrgent) => Promise<unknown>; rank: number; urgent: boolean; generation: number;
  resolve: (v: unknown) => void; reject: (e: unknown) => void;
  timer?: ReturnType<typeof setTimeout>; signal?: AbortSignal; onAbort?: () => void;
}
const noYield: YieldToUrgent = () => Promise.resolve();

export class CommandGate {
  private running = false;
  private current: Entry | null = null;
  private queue: Entry[] = [];
  constructor(private session: () => number, private readonly limit = GATE_QUEUE_LIMIT,
    private readonly queueTimeoutMs = GATE_QUEUE_TIMEOUT_MS) {}

  /** Commands waiting (not yet on the wire). */
  get queued(): number { return this.queue.length; }
  /** True while a command is on the wire. */
  get busy(): boolean { return this.running; }

  /** `opts === true` is the legacy Stop flag (urgent). `work` may await its `yieldToUrgent` argument
   * between the lines of a compound call. */
  run<T>(work: (yieldToUrgent: YieldToUrgent) => Promise<T>, opts: boolean | GateRunOptions = {}): Promise<T> {
    const o: GateRunOptions = typeof opts === "boolean" ? { priority: opts ? "urgent" : "normal" } : opts;
    const priority = o.priority ?? "normal";
    const urgent = priority === "urgent";
    if (o.signal?.aborted) return Promise.reject(new GateCancelledError());
    if (o.exclusive && (this.running || this.queue.length > 0)) return Promise.reject(new GateBusyError(GATE_START_BUSY_MESSAGE, "GATE_BUSY_START"));
    if (!urgent && (this.running || this.queue.length > 0) && this.queue.filter(e => !e.urgent).length >= this.limit) return Promise.reject(new GateBusyError(GATE_BUSY_MESSAGE, "GATE_QUEUE_FULL"));
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
    for (const e of waiting) { this.cleanup(e); e.reject(new GateDisconnectedError(message)); }
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
  /** Run every waiting urgent command now, one at a time, while `owner` (a compound entry) holds
   * the gate between two of its lines. Only the entry that currently holds the gate may yield. */
  private async yieldToUrgent(owner: Entry): Promise<void> {
    while (this.current === owner && this.queue.length > 0 && this.queue[0].urgent) {
      const u = this.queue.shift()!;
      this.cleanup(u);
      if (u.generation !== this.session()) { u.reject(new GateSessionChangedError()); continue; }
      try { u.resolve(await u.work(noYield)); } catch (e) { u.reject(e); }
    }
  }
  private pump(): void {
    if (this.running) return;
    const next = this.queue.shift();
    if (!next) return;
    this.cleanup(next);
    if (next.generation !== this.session()) {
      next.reject(new GateSessionChangedError());
      this.pump();
      return;
    }
    this.running = true;
    this.current = next;
    // Dispatch on a microtask, like the pre-queue gate (work never runs inside run()).
    // The gate frees (and the next waiting command is taken) before the caller sees its result.
    const settle = (fn: () => void) => { this.running = false; this.current = null; this.pump(); fn(); };
    const yieldHook: YieldToUrgent = () => this.yieldToUrgent(next);
    Promise.resolve().then(() => next.work(yieldHook)).then(
      (v) => settle(() => next.resolve(v)),
      (e) => settle(() => next.reject(e)));
  }
}
