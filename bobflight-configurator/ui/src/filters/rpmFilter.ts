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
 *
 * Busy gate (QA #60): the shared CommandGate refuses, never queues, a command
 * while another is in flight (e.g. the Motors-tab eRPM poll). That refusal
 * happens before anything is sent, so it is the ONLY outcome retried, up to
 * RPM_GATE_ATTEMPTS tries RPM_GATE_DELAY_MS apart. An FC reply (a `set failed`
 * line, a malformed value, "unknown key") or any other error is never retried,
 * so an accepted set is never sent again. Still refused after the last try:
 * a read is `busy` (shown "unknown" with the gate's message, never malformed
 * or "older FC"); a set returns the gate's message like any other error. An
 * aborted `signal` (unmount, newer read) stops the retries: RpmCancelled is
 * thrown and nothing more is sent.
 */
import {
  RPM_FILTER_KEYS, parseRpmFilterReport, qFromX100, qToX100, rpmFilterView, rpmValueProblem,
  type RpmFilterKey, type RpmFilterReportResult, type RpmFilterView, type RpmGetResult, type SettingsKey,
} from "../protocol";
import type { CliCommand } from "../protocol/types";
import { isGateBusy } from "../protocol/commandGate";

export interface RpmHost {
  getSetting(key: SettingsKey): Promise<{ key: SettingsKey; value: string }>;
  setSetting(key: SettingsKey, value: string): Promise<{ key: SettingsKey; value: string }>;
  sendCommand(cmd: CliCommand): Promise<string>;
  /** Optional: the Motors-tab panel re-reads when the connection status changes. */
  onStatus?(cb: (s: string) => void): () => void;
  getConnectionStatus?(): string;
}

/** A `get` result, or `busy`: the command gate stayed busy for every try, so nothing was read. */
export type RpmReadResult = RpmGetResult | { kind: "busy"; message: string };
export interface RpmSnapshot {
  values: Record<RpmFilterKey, RpmReadResult | null>;
  report: RpmFilterReportResult | null;
}
export function emptyRpmSnapshot(): RpmSnapshot {
  return { values: { rpm_filter_harmonics: null, rpm_filter_min_hz: null, rpm_filter_q_x100: null, motor_poles: null }, report: null };
}

export const RPM_GATE_ATTEMPTS = 30;
export const RPM_GATE_DELAY_MS = 100;
/** The caller's signal aborted while a command was waiting for the gate: nothing more is sent. */
export class RpmCancelled extends Error {
  constructor() { super("RPM command cancelled"); this.name = "RpmCancelled"; }
}
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(t); signal?.removeEventListener("abort", done); resolve(); };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}
/** Runs `fn`; retries only the gate's own refusal (nothing was sent), at most RPM_GATE_ATTEMPTS tries. */
async function gated<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) throw new RpmCancelled();
    try {
      return await fn();
    } catch (e) {
      if (!isGateBusy(e) || attempt >= RPM_GATE_ATTEMPTS) throw e;
    }
    await pause(RPM_GATE_DELAY_MS, signal);
  }
}

export async function readRpmKey(host: RpmHost, key: RpmFilterKey, signal?: AbortSignal): Promise<RpmReadResult> {
  try {
    const { value } = await gated(() => host.getSetting(key as SettingsKey), signal);
    return Number.isFinite(Number(value)) && value.trim() !== "" ? { kind: "value", value } : { kind: "malformed", raw: value };
  } catch (e) {
    if (e instanceof RpmCancelled) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (isGateBusy(e)) return { kind: "busy", message: msg };
    return /unknown key/.test(msg) ? { kind: "unsupported" } : { kind: "malformed", raw: msg };
  }
}
/** The parsed report; null when missing (older FC) or the gate stayed busy (shown "unknown"). */
export async function readRpmReport(host: RpmHost, signal?: AbortSignal): Promise<RpmFilterReportResult | null> {
  try { return parseRpmFilterReport(await gated(() => host.sendCommand("rpm_filter"), signal)); } catch (e) {
    if (e instanceof RpmCancelled) throw e;
    return null;
  }
}
/** `get` for the four keys, then the `rpm_filter` report. */
export async function readRpm(host: RpmHost, signal?: AbortSignal): Promise<RpmSnapshot> {
  const snap = emptyRpmSnapshot();
  for (const k of RPM_FILTER_KEYS) snap.values[k] = await readRpmKey(host, k, signal);
  snap.report = await readRpmReport(host, signal);
  return snap;
}

/** Older FC (schema < 9, a key or the report missing) makes the section read-only and unknown. */
export function rpmView(snap: RpmSnapshot, schema: number | null): RpmFilterView {
  // A `busy` key was not read: the view treats it as missing, so the section shows "unknown".
  const read: Partial<Record<RpmFilterKey, RpmGetResult | null>> = {};
  for (const k of RPM_FILTER_KEYS) { const r = snap.values[k]; read[k] = r?.kind === "busy" ? null : r; }
  const v = rpmFilterView(read, snap.report);
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
 * the FC's line is returned verbatim and the key is still re-read. Only a
 * gate refusal of the set itself is retried (it was never sent); once the FC
 * answered, the set is not sent again and only the `get` / report are retried.
 */
export async function applyRpmSetting(host: RpmHost, snap: RpmSnapshot, key: RpmFilterKey, n: number, signal?: AbortSignal): Promise<RpmSetResult> {
  const ops = [`set ${key} ${n}`];
  let fcLine: string | null = null;
  try { await gated(() => host.setSetting(key as SettingsKey, String(n)), signal); } catch (e) {
    if (e instanceof RpmCancelled) throw e;
    fcLine = e instanceof Error ? e.message : String(e);
  }
  ops.push(`get ${key}`);
  const value = await readRpmKey(host, key, signal);
  ops.push("rpm_filter");
  const report = await readRpmReport(host, signal);
  const next: RpmSnapshot = { values: { ...snap.values, [key]: value }, report };
  return fcLine === null ? { ok: true, ops, snap: next } : { ok: false, ops, fcLine, snap: next };
}

export { qFromX100 };
