/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * RPM notch filter section (FW config schema 9). Pure logic, no React, so it
 * runs under Node tests. Shared by the Filters tab (harmonics, min Hz, Q) and
 * the Motors tab (motor_poles).
 *
 * Review bar: a missing key or report field shows "unknown"; values and the
 * FC's tokens are shown exactly as sent; motor Hz come only from the FC's
 * rpm_filter_mN_hz (never from erpm_mN); every `set` is followed by `get <key>`
 * and then `rpm_filter` (no optimistic update); a refused set shows the FC's
 * line verbatim and the inputs return to what the FC holds.
 */
import {
  RPM_FILTER_KEYS, parseRpmFilterReport, qFromX100, qToX100, rpmFilterView, rpmValueProblem,
  type RpmFilterKey, type RpmFilterReportResult, type RpmFilterView, type RpmGetResult, type SettingsKey,
} from "../protocol";
import type { CliCommand } from "../protocol/types";

export interface RpmHost {
  getSetting(key: SettingsKey): Promise<{ key: SettingsKey; value: string }>;
  setSetting(key: SettingsKey, value: string): Promise<{ key: SettingsKey; value: string }>;
  sendCommand(cmd: CliCommand): Promise<string>;
  /** Optional: the Motors-tab panel re-reads when the connection status changes. */
  onStatus?(cb: (s: string) => void): () => void;
  getConnectionStatus?(): string;
}

export interface RpmSnapshot {
  values: Record<RpmFilterKey, RpmGetResult | null>;
  report: RpmFilterReportResult | null;
}
export function emptyRpmSnapshot(): RpmSnapshot {
  return { values: { rpm_filter_harmonics: null, rpm_filter_min_hz: null, rpm_filter_q_x100: null, motor_poles: null }, report: null };
}

export async function readRpmKey(host: RpmHost, key: RpmFilterKey): Promise<RpmGetResult> {
  try {
    const { value } = await host.getSetting(key as SettingsKey);
    return Number.isFinite(Number(value)) && value.trim() !== "" ? { kind: "value", value } : { kind: "malformed", raw: value };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /unknown key/.test(msg) ? { kind: "unsupported" } : { kind: "malformed", raw: msg };
  }
}
export async function readRpmReport(host: RpmHost): Promise<RpmFilterReportResult | null> {
  try { return parseRpmFilterReport(await host.sendCommand("rpm_filter")); } catch { return null; }
}
/** `get` for the four keys, then the `rpm_filter` report. */
export async function readRpm(host: RpmHost): Promise<RpmSnapshot> {
  const snap = emptyRpmSnapshot();
  for (const k of RPM_FILTER_KEYS) snap.values[k] = await readRpmKey(host, k);
  snap.report = await readRpmReport(host);
  return snap;
}

/** Older FC (schema < 9, a key or the report missing) makes the section read-only and unknown. */
export function rpmView(snap: RpmSnapshot, schema: number | null): RpmFilterView {
  const v = rpmFilterView(snap.values, snap.report);
  if (schema !== null && schema < 9 && v.supported) return rpmFilterView({}, null);
  return v;
}

/** Editable Filters-tab inputs (motor_poles is edited on the Motors tab). */
export interface RpmDraft { harmonics: string; minHz: string; q: string; }
export function rpmDraftFromView(v: RpmFilterView): RpmDraft {
  return v.supported ? { harmonics: v.harmonics, minHz: v.minHz, q: v.q } : { harmonics: "", minHz: "", q: "" };
}

/** Integer to send per key; null when the input is not a whole number (or Q has more than 2 decimals). */
export function rpmDraftValues(d: RpmDraft): Record<"rpm_filter_harmonics" | "rpm_filter_min_hz" | "rpm_filter_q_x100", number | null> {
  const int = (s: string) => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : null);
  return { rpm_filter_harmonics: int(d.harmonics), rpm_filter_min_hz: int(d.minHz), rpm_filter_q_x100: qToX100(d.q) };
}
/** Keys whose draft differs from what the FC holds. */
export function rpmDirtyKeys(v: RpmFilterView, d: RpmDraft): Array<"rpm_filter_harmonics" | "rpm_filter_min_hz" | "rpm_filter_q_x100"> {
  if (!v.supported) return [];
  const out: Array<"rpm_filter_harmonics" | "rpm_filter_min_hz" | "rpm_filter_q_x100"> = [];
  if (d.harmonics.trim() !== v.harmonics) out.push("rpm_filter_harmonics");
  if (d.minHz.trim() !== v.minHz) out.push("rpm_filter_min_hz");
  if (qToX100(d.q) === null || String(qToX100(d.q)) !== v.qX100) out.push("rpm_filter_q_x100");
  return out;
}
/** Client-side hint (worded unlike FW text); the FC re-checks and its line wins. */
export function rpmDraftProblem(v: RpmFilterView, d: RpmDraft): string | null {
  const vals = rpmDraftValues(d);
  for (const k of rpmDirtyKeys(v, d)) {
    const n = vals[k];
    if (n === null) return k === "rpm_filter_q_x100" ? "Q: use a number with at most two decimals." : `${k}: use a whole number.`;
    const p = rpmValueProblem(k, n);
    if (p) return `${k}: ${p}`;
  }
  return null;
}

export type RpmSetResult = { ok: true; ops: string[]; snap: RpmSnapshot } | { ok: false; ops: string[]; fcLine: string; snap: RpmSnapshot };
/**
 * One RPM setting: `set <key> <n>`, then `get <key>`, then `rpm_filter`.
 * `snap` is merged with the re-read key and the new report; on a refusal
 * the FC's line is returned verbatim and the key is still re-read.
 */
export async function applyRpmSetting(host: RpmHost, snap: RpmSnapshot, key: RpmFilterKey, n: number): Promise<RpmSetResult> {
  const ops = [`set ${key} ${n}`];
  let fcLine: string | null = null;
  try { await host.setSetting(key as SettingsKey, String(n)); } catch (e) { fcLine = e instanceof Error ? e.message : String(e); }
  ops.push(`get ${key}`);
  const value = await readRpmKey(host, key);
  ops.push("rpm_filter");
  const report = await readRpmReport(host);
  const next: RpmSnapshot = { values: { ...snap.values, [key]: value }, report };
  return fcLine === null ? { ok: true, ops, snap: next } : { ok: false, ops, fcLine, snap: next };
}

export { qFromX100 };
