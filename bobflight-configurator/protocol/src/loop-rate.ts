/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Loop-rate keys in the CLI `status` reply (frozen contract, FW
 * bobflight-firmware/src/drivers/loop_status_cli.h):
 *
 *   loop_target_hz: <uint32>                 scheduler gyro_hz / pid_denom
 *   loop_actual_hz: <uint32>|unavailable     PID cascade runs in the last closed ~1 s window
 *   loop_overruns: <uint64>                  scheduler overruns since boot (same counter as timing cycle_overruns)
 *
 * Honesty rules (Configurator Lead review bar):
 * - A missing key, the literal `unavailable`, a duplicated key, or any
 *   non-canonical value is unknown (null). The UI shows "unknown" and never 0
 *   or the target in its place.
 * - The target comes only from `loop_target_hz`. It is never computed here
 *   from `loop:` gyro/denom and never defaulted.
 * - Values stay the firmware's canonical decimal strings and are displayed
 *   exactly as sent. `loop_overruns` is uint64 and never goes through Number().
 *
 * parseUint64 and the duplicate-key rule are reused from the Configurator
 * Lead's timing parser work (same project, Apache-2.0).
 */
export const LOOP_STATUS_KEYS = ["loop_target_hz", "loop_actual_hz", "loop_overruns"] as const;
export type LoopStatusKey = (typeof LOOP_STATUS_KEYS)[number];
export const LOOP_UNKNOWN = "unknown";
export const LOOP_ACTUAL_UNAVAILABLE = "unavailable";
const UINT32_MAX = BigInt("4294967295");
const UINT64_MAX = BigInt("18446744073709551615");
/** Canonical decimal: "0" or no leading zeros, digits only. */
const CANONICAL = /^(?:0|[1-9][0-9]{0,19})$/;

function canonicalUint(raw: string | undefined, max: bigint): string | null {
  if (raw === undefined || !CANONICAL.test(raw)) return null;
  return BigInt(raw) <= max ? raw : null;
}
/** Canonical uint64 decimal string exactly as sent, or null. */
export function parseUint64(raw: string | undefined): string | null { return canonicalUint(raw, UINT64_MAX); }
/** Canonical uint32 decimal string exactly as sent, or null. */
export function parseUint32(raw: string | undefined): string | null { return canonicalUint(raw, UINT32_MAX); }

/** How the firmware reported a key; the display value is unknown for all but "value". */
export type LoopFieldState = "value" | "missing" | "unavailable" | "duplicate" | "malformed";
export interface LoopStatus {
  /** loop_target_hz digits; null = unknown. A 0 target is not meaningful and is unknown. */
  targetHz: string | null;
  /** loop_actual_hz digits (may legitimately be "0" after a long stall); null = unknown. */
  actualHz: string | null;
  /** loop_overruns uint64 digits; null = unknown. */
  overruns: string | null;
  state: Record<LoopStatusKey, LoopFieldState>;
  /** None of the three keys present: firmware predates the loop-rate contract. */
  olderFirmware: boolean;
}

/** Parse the three loop keys from a raw `status` reply (other lines are ignored). */
export function parseLoopStatus(raw: string): LoopStatus {
  const fields = new Map<string, string>();
  const duplicated = new Set<string>();
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const m = /^(loop_[a-z_]+):(.*)$/.exec(rawLine.trim());
    if (!m || !(LOOP_STATUS_KEYS as readonly string[]).includes(m[1])) continue;
    if (fields.has(m[1])) duplicated.add(m[1]);
    fields.set(m[1], m[2].trim());
  }
  const state = {} as Record<LoopStatusKey, LoopFieldState>;
  const read = (key: LoopStatusKey, parse: (v: string) => string | null, allowUnavailable: boolean): string | null => {
    const v = fields.get(key);
    if (v === undefined) { state[key] = "missing"; return null; }
    if (duplicated.has(key)) { state[key] = "duplicate"; return null; }
    if (allowUnavailable && v === LOOP_ACTUAL_UNAVAILABLE) { state[key] = "unavailable"; return null; }
    const parsed = parse(v);
    state[key] = parsed === null ? "malformed" : "value";
    return parsed;
  };
  const targetHz = read("loop_target_hz", v => { const d = parseUint32(v); return d === "0" ? null : d; }, false);
  const actualHz = read("loop_actual_hz", parseUint32, true);
  const overruns = read("loop_overruns", parseUint64, false);
  const olderFirmware = LOOP_STATUS_KEYS.every(k => state[k] === "missing");
  return { targetHz, actualHz, overruns, state, olderFirmware };
}

export const LOOP_LABELS = {
  target: "Loop target (Hz)",
  actual: "Loop actual (Hz, last ~1 s)",
  overruns: "Loop overruns (since boot)",
} as const;

export interface LoopRateItem { key: "target" | "actual" | "overruns"; label: string; value: string }
export interface LoopRateView { items: [LoopRateItem, LoopRateItem, LoopRateItem]; notice: string | null }

/** Display model: digits exactly as sent, otherwise "unknown". Never 0 or the target as a stand-in. */
export function loopRateView(s: LoopStatus | null): LoopRateView {
  const show = (v: string | null | undefined) => (v === null || v === undefined ? LOOP_UNKNOWN : v);
  const items: LoopRateView["items"] = [
    { key: "target", label: LOOP_LABELS.target, value: show(s?.targetHz) },
    { key: "actual", label: LOOP_LABELS.actual, value: show(s?.actualHz) },
    { key: "overruns", label: LOOP_LABELS.overruns, value: show(s?.overruns) },
  ];
  let notice: string | null = null;
  if (!s) notice = "No status reading yet.";
  else if (s.olderFirmware) notice = "This firmware does not report loop rate (older FC).";
  else if (s.state.loop_actual_hz === "unavailable") notice = "Firmware is still measuring: the first ~1 s window has not closed.";
  else if (LOOP_STATUS_KEYS.some(k => s.state[k] !== "value")) notice = "Some loop-rate keys were missing or malformed and are shown as unknown.";
  return { items, notice };
}
