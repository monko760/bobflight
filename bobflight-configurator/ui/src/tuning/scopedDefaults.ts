/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Per-tab defaults (D1): `defaults pid|rates|filters`. React-free so it can be
 * tested on the real CommandGate/adapter/client.
 *
 * Honesty rules:
 *  - Only the gate's own refusal (nothing reached the FC) is retried, bounded.
 *  - An FC `defaults_error:` line (or an older FC's unknown-command line) is
 *    shown verbatim; nothing else replaces it.
 *  - Success needs the complete frame (group, keys, matching end + count). An
 *    incomplete/inconsistent frame or a transport failure after the command
 *    went out is "Defaults result unknown, re-read": never assumed applied.
 *  - Nothing is saved here. After a reset the FC's own `storage` report says
 *    whether RAM now differs from flash (the FW compares, so defaults equal to
 *    the saved values leave it clean); the UI shows that report, not a guess.
 */
import {
  DEFAULTS_GROUP_KEYS,
  DEFAULTS_RESULT_UNKNOWN,
  parseStorage,
  type BobFlightHost,
  type DefaultsGroup,
  type SettingsKey,
} from "../protocol";
import { isGateBusy, isGateNotSent } from "../protocol";

export { DEFAULTS_RESULT_UNKNOWN };

export const DEFAULTS_GROUP_LABEL: Readonly<Record<DefaultsGroup, string>> = { pid: "PID", rates: "Rates", filters: "Filters" };

/** Total time the gate's own refusal is retried before giving up (nothing was sent meanwhile). */
export const DEFAULTS_GATE_WAIT_MS = 2500;
export const DEFAULTS_GATE_STEP_MS = 100;
export const DEFAULTS_BUSY_TEXT = "Another command was using the connection; nothing was changed. Try again.";
export const DEFAULTS_NO_HOST_TEXT = "This connection cannot restore per-tab defaults.";
export const DEFAULTS_VALUE_UNKNOWN = "unknown";
export const DEFAULTS_UNSAVED_TEXT =
  "Not saved: the controller holds these defaults in RAM only and its storage reports unsaved changes. Press Save to keep them; a reboot without Save brings back the saved values.";
export const DEFAULTS_CLEAN_TEXT =
  "Nothing to save: the controller's storage reports no unsaved changes (these defaults equal the saved values).";
export const DEFAULTS_MAYBE_UNSAVED_TEXT =
  "Storage may have unsaved changes. Check the re-read values before you press Save; a reboot without Save brings back the saved values.";
export const DEFAULTS_UNSUPPORTED_TEXT = "This firmware has no per-tab defaults. Nothing was changed.";

type DefaultsHost = Pick<BobFlightHost, "getSetting" | "getConnectionStatus"> & Partial<Pick<BobFlightHost, "sendCommand">> & Partial<Pick<BobFlightHost, "restoreDefaultsGroup">>;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Nothing reached the FC: the gate refused (busy) past the bounded retry, or it dropped the command
 * (queue timeout, cancel, disconnect, session change). `cause` is the gate's own error. */
class GateStillBusy extends Error {
  constructor(readonly cause: unknown) { super(cause instanceof Error ? cause.message : String(cause)); }
}

/**
 * Runs `fn`. Matched on the gate's error code, never its text: a busy refusal
 * (isGateBusy) is retried until `waitMs` passed; any other "not sent" gate
 * error (isGateNotSent: queue timeout, cancel, disconnect, session change) is
 * not retried. Both throw GateStillBusy. FC replies and transport errors
 * (the command may have gone out) are rethrown as they are.
 */
async function gatedOnce<T>(fn: () => Promise<T>, waitMs = DEFAULTS_GATE_WAIT_MS): Promise<T> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      if (!isGateNotSent(e)) throw e;
      if (!isGateBusy(e) || Date.now() + DEFAULTS_GATE_STEP_MS > deadline) throw new GateStillBusy(e);
    }
    await sleep(DEFAULTS_GATE_STEP_MS);
  }
}

/**
 * Runs a page read, retrying only a busy gate refusal for up to
 * DEFAULTS_GATE_WAIT_MS; then rethrows the gate's own error (so callers can
 * still test it with isGateBusy / isGateNotSent). FC replies and transport
 * errors are never retried.
 */
export async function retryWhileGateBusy<T>(fn: () => Promise<T>, waitMs = DEFAULTS_GATE_WAIT_MS): Promise<T> {
  try {
    return await gatedOnce(fn, waitMs);
  } catch (e) {
    throw e instanceof GateStillBusy ? e.cause : e;
  }
}

export type CurrentValues = Record<string, string>;
export type ReadCurrentResult = { kind: "ok"; values: CurrentValues } | { kind: "busy"; detail: string };

/** Current FC values of one group's keys, read one `get` at a time. A failed key shows unknown (with the reason). */
export async function readGroupValues(host: DefaultsHost, group: DefaultsGroup): Promise<ReadCurrentResult> {
  const values: CurrentValues = {};
  for (const key of DEFAULTS_GROUP_KEYS[group]) {
    try {
      values[key] = (await gatedOnce(() => host.getSetting(key as SettingsKey))).value;
    } catch (e) {
      if (e instanceof GateStillBusy) return { kind: "busy", detail: e.message };
      const msg = e instanceof Error ? e.message : String(e);
      values[key] = /unknown key/.test(msg) ? `${DEFAULTS_VALUE_UNKNOWN} (not on this FC)` : `${DEFAULTS_VALUE_UNKNOWN} (${msg})`;
    }
  }
  return { kind: "ok", values };
}

export type DefaultsOutcome =
  | { kind: "ok"; group: DefaultsGroup; count: number; keyLines: string[] }
  | { kind: "error"; line: string }
  | { kind: "unsupported"; line: string }
  | { kind: "unknown"; detail: string; keyLines: string[] }
  | { kind: "busy"; detail: string }
  | { kind: "no-host" };

/** Sends `defaults <group>` once (gate refusals retried, bounded) and classifies the FC reply. */
export async function runGroupDefaults(host: DefaultsHost, group: DefaultsGroup): Promise<DefaultsOutcome> {
  if (typeof host.restoreDefaultsGroup !== "function") return { kind: "no-host" };
  let r;
  try {
    r = await gatedOnce(() => host.restoreDefaultsGroup!(group));
  } catch (e) {
    if (e instanceof GateStillBusy) return { kind: "busy", detail: e.message };
    // The command may have reached the FC: the outcome is unknown.
    return { kind: "unknown", detail: e instanceof Error ? e.message : String(e), keyLines: [] };
  }
  switch (r.kind) {
    case "ok": return { kind: "ok", group: r.group, count: r.count, keyLines: r.keyLines };
    case "error": return { kind: "error", line: r.line };
    case "unsupported": return { kind: "unsupported", line: r.line };
    default: return { kind: "unknown", detail: r.reason, keyLines: r.keyLines };
  }
}

/** The FC's own `storage` dirty flag after a reset; null when it could not be read (shown as "may have unsaved changes"). */
export async function readStorageDirty(host: DefaultsHost): Promise<boolean | null> {
  if (!host.sendCommand) return null;
  try {
    return parseStorage(await gatedOnce(() => host.sendCommand!("storage"))).dirty;
  } catch {
    return null;
  }
}
