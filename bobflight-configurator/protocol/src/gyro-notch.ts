/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Manual gyro notches (FW config schema 8). Frozen FW contract
 * (bobflight-firmware/src/drivers/filters_cli.h, flight/config.c, flight/filter.h):
 *
 *   keys (persisted floats, %.6g like gyro_lpf_hz):
 *     gyro_notch1_hz / gyro_notch2_hz                centre; 0 = off, else 20..1000
 *     gyro_notch1_cutoff_hz / gyro_notch2_cutoff_hz  lower -3 dB edge; 0 < cutoff < centre
 *   get <key>   -> "<key>=<v>"                 older FC: "unknown key"
 *   set <key> v -> "ok <key>=<v>"  or a line starting "set failed" (shown verbatim)
 *                  A nonzero centre needs its cutoff first; changes follow notchWritePlan
 *                  (centre 0 first only when turning off or when the current value is unknown).
 *   filters     -> framed report:
 *                    filters_api: 1
 *                    filters_sample_hz: <actual gyro-filter rate, Hz>
 *                    gyro_notch1_active: yes|no
 *                    gyro_notch1_reason: off|ok|above-nyquist|invalid
 *                    gyro_notch2_active: yes|no
 *                    gyro_notch2_reason: off|ok|above-nyquist|invalid
 *                    filters_end: 1
 *                  older FC: "unknown — try help"
 *
 * The FC is the authority: the sample-rate (Nyquist) limit is decided only by
 * the firmware and shown through its reason token. Nothing here computes it.
 * Values and report tokens are kept as the exact strings the FC sent.
 */
export const GYRO_NOTCH_KEYS = ["gyro_notch1_hz", "gyro_notch1_cutoff_hz", "gyro_notch2_hz", "gyro_notch2_cutoff_hz"] as const;
export type GyroNotchKey = (typeof GYRO_NOTCH_KEYS)[number];
export const GYRO_NOTCH_INDEXES = [1, 2] as const;
export type GyroNotchIndex = (typeof GYRO_NOTCH_INDEXES)[number];
export const GYRO_NOTCH_UNKNOWN = "unknown";
/** Reason tokens the FW documents (others are still shown verbatim). */
export const GYRO_NOTCH_REASONS = ["off", "ok", "above-nyquist", "invalid"] as const;

export function notchCenterKey(i: GyroNotchIndex): GyroNotchKey { return i === 1 ? "gyro_notch1_hz" : "gyro_notch2_hz"; }
export function notchCutoffKey(i: GyroNotchIndex): GyroNotchKey { return i === 1 ? "gyro_notch1_cutoff_hz" : "gyro_notch2_cutoff_hz"; }
export function isGyroNotchKey(k: string): k is GyroNotchKey { return (GYRO_NOTCH_KEYS as readonly string[]).includes(k); }

/** Allowlisted exact CLI lines for the notch feature (plain decimal values only). */
export function isGyroNotchCliCommand(cmd: string): boolean {
  if (cmd === "filters") return true;
  if (/^get gyro_notch[12]_(?:cutoff_)?hz$/.test(cmd)) return true;
  return /^set gyro_notch[12]_(?:cutoff_)?hz (?:0|[1-9]\d{0,3})(?:\.\d{1,6})?$/.test(cmd);
}

/** Single-value domain (mirror of the FW, UI hint only — never the authority). */
export function validateNotchCenter(v: number): boolean { return Number.isFinite(v) && (v === 0 || (v >= 20 && v <= 1000)); }
export function validateNotchCutoffAlone(v: number): boolean { return Number.isFinite(v) && v >= 0 && v < 1000; }
/**
 * Pair rule mirror (FW config_gyro_notch_pair_valid): centre 0 (cutoff 0..<1000)
 * or centre 20..1000 with 0 < cutoff < centre. Returns a hint, or null when valid.
 */
export function notchPairProblem(center: number, cutoff: number): string | null {
  if (!Number.isFinite(center) || !Number.isFinite(cutoff)) return "Enter numbers.";
  if (center === 0) return cutoff >= 0 && cutoff < 1000 ? null : "Cutoff must be 0 or more and below 1000 Hz.";
  if (center < 20 || center > 1000) return "Centre must be 0 (off) or 20..1000 Hz.";
  if (!(cutoff > 0 && cutoff < center)) return "Cutoff must be above 0 and below the centre.";
  return null;
}

export interface NotchPair { center: number; cutoff: number; }
/**
 * FW-safe write order for one notch: every intermediate pair is valid under
 * the FW pair rule, and an enabled notch is only switched off when the target
 * is off or the current value is unknown. So a refused centre (e.g. the FC's
 * loop-rate check) leaves the stored centre as it was.
 * `current` null (unknown) writes centre 0, cutoff, centre. Returns [] when nothing changes.
 */
export function notchWritePlan(i: GyroNotchIndex, current: NotchPair | null, next: NotchPair): Array<{ key: GyroNotchKey; value: number }> {
  const c = notchCenterKey(i), f = notchCutoffKey(i);
  if (current && current.center === next.center && current.cutoff === next.cutoff) return [];
  const center = { key: c, value: next.center }, cutoff = { key: f, value: next.cutoff };
  if (current && current.center !== 0 && next.center !== 0) {
    if (current.center === next.center) return [cutoff];
    if (current.cutoff === next.cutoff) return [center];
    // (current.center, next.cutoff) valid when next.cutoff < current.center; else
    // (next.center, current.cutoff) is valid (the two cannot both fail).
    return next.cutoff < current.center ? [cutoff, center] : [center, cutoff];
  }
  const plan: Array<{ key: GyroNotchKey; value: number }> = [];
  if (!current || current.center !== 0) plan.push({ key: c, value: 0 });
  if (!current || current.cutoff !== next.cutoff) plan.push(cutoff);
  if (next.center !== 0) plan.push(center);
  return plan;
}

const lines = (raw: string) => String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export type NotchGetResult = { kind: "value"; value: string } | { kind: "unsupported" } | { kind: "malformed"; raw: string };
/** `get <notch key>`: FW %.6g value string kept verbatim; "unknown key" = older FC. */
export function parseNotchGetReply(raw: string, key: GyroNotchKey): NotchGetResult {
  const ls = lines(raw);
  if (ls.length === 1 && ls[0] === "unknown key") return { kind: "unsupported" };
  const m = ls.length === 1 ? /^([a-z0-9_]+)=(\S+)$/.exec(ls[0]) : null;
  if (m && m[1] === key && Number.isFinite(Number(m[2]))) return { kind: "value", value: m[2] };
  return { kind: "malformed", raw: String(raw).trim() };
}

export type NotchSetResult = { ok: true; value: string } | { ok: false; unsupported: boolean; message: string };
/** `set <notch key> v`: ok only when the FW echoes the key; failures keep the FW line verbatim. */
export function parseNotchSetReply(raw: string, key: GyroNotchKey): NotchSetResult {
  const ls = lines(raw);
  const first = ls[0] ?? "";
  const m = /^ok ([a-z0-9_]+)=(\S+)$/.exec(first);
  if (m && m[1] === key && ls.length === 1) return { ok: true, value: m[2] };
  return { ok: false, unsupported: first === "unknown key", message: first || "no reply" };
}

export interface NotchReport { active: string | null; reason: string | null; }
export interface FiltersReport { sampleHz: string | null; notches: Record<GyroNotchIndex, NotchReport>; }
export type FiltersReportResult = { kind: "report"; report: FiltersReport } | { kind: "unsupported" } | { kind: "malformed"; raw: string };
/**
 * Framed `filters` report. A missing, duplicated or blank field is null
 * (unknown). Tokens are kept exactly as sent: an undocumented reason is
 * returned as-is, never mapped to ok.
 */
export function parseFiltersReport(raw: string): FiltersReportResult {
  const ls = lines(raw);
  if (ls.length >= 1 && /^unknown\b.*try help$/.test(ls[0]) && !ls.includes("filters_api: 1")) return { kind: "unsupported" };
  const s = ls.indexOf("filters_api: 1"), e = ls.lastIndexOf("filters_end: 1");
  if (s < 0 || e < s) return { kind: "malformed", raw: String(raw).trim() };
  const seen = new Map<string, string>(), dup = new Set<string>();
  for (const l of ls.slice(s + 1, e)) {
    const m = /^([a-z0-9_]+): (\S+)$/.exec(l);
    if (!m) continue;
    if (seen.has(m[1])) dup.add(m[1]);
    seen.set(m[1], m[2]);
  }
  const get = (k: string): string | null => (dup.has(k) ? null : seen.get(k) ?? null);
  const n = (i: GyroNotchIndex): NotchReport => ({ active: get(`gyro_notch${i}_active`), reason: get(`gyro_notch${i}_reason`) });
  return { kind: "report", report: { sampleHz: get("filters_sample_hz"), notches: { 1: n(1), 2: n(2) } } };
}

export interface NotchRowView {
  index: GyroNotchIndex;
  /** false: older FC (keys missing) — row disabled, everything "unknown". */
  supported: boolean;
  center: string; cutoff: string;
  /** Centre is exactly "0": notch off; the cutoff input is disabled but keeps its value. */
  off: boolean | null;
  cutoffDisabled: boolean;
  active: string; reason: string;
}
/**
 * Row display model. `center`/`cutoff` are the FC's get strings (null =
 * missing); `report` the parsed `filters` reply (null = not reported).
 * `active`/`reason` come only from the report's own tokens: a missing token
 * is "unknown". Nothing is inferred from `filters_sample_hz` or the centre
 * (the FC alone decides above-nyquist).
 */
export function notchRowView(index: GyroNotchIndex, center: NotchGetResult | null, cutoff: NotchGetResult | null, report: FiltersReportResult | null): NotchRowView {
  const supported = center?.kind === "value" && cutoff?.kind === "value";
  const cv = center?.kind === "value" ? center.value : null;
  const fv = cutoff?.kind === "value" ? cutoff.value : null;
  const r = report?.kind === "report" ? report.report.notches[index] : null;
  const off = cv === null ? null : Number(cv) === 0;
  return {
    index, supported,
    center: supported && cv !== null ? cv : GYRO_NOTCH_UNKNOWN,
    cutoff: supported && fv !== null ? fv : GYRO_NOTCH_UNKNOWN,
    off: supported ? off : null,
    cutoffDisabled: !supported || off !== false,
    active: supported && r?.active ? r.active : GYRO_NOTCH_UNKNOWN,
    reason: supported && r?.reason ? r.reason : GYRO_NOTCH_UNKNOWN,
  };
}
