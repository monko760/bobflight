/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Filters tab: manual gyro notch rows (FW config schema 8). Pure logic, no
 * React, so it runs under Node tests.
 *
 * Review bar: a missing key shows "unknown" (never 0 or off); values and the
 * FC's active/reason tokens are shown exactly as sent; the Nyquist limit is
 * never computed here (only the FC's reason is shown); after every `set` the
 * rows are re-read with `get` (no optimistic update); a refused set shows the
 * FC's line verbatim. Nothing here feeds a StoragePanel `blocked`.
 */
import {
  GYRO_NOTCH_INDEXES, GYRO_NOTCH_UNKNOWN, notchCenterKey, notchCutoffKey, notchPairProblem, notchWritePlan,
  parseFiltersReport, parseStorage, notchRowView,
  type FiltersReportResult, type GyroNotchIndex, type NotchGetResult, type NotchPair, type NotchRowView, type SettingsKey,
} from "../protocol";
import type { CliCommand } from "../protocol/types";
import { isGateNotSent } from "../protocol/commandGate";

export interface NotchHost {
  getSetting(key: SettingsKey): Promise<{ key: SettingsKey; value: string }>;
  setSetting(key: SettingsKey, value: string): Promise<{ key: SettingsKey; value: string }>;
  sendCommand(cmd: CliCommand): Promise<string>;
}

export interface NotchSnapshot {
  /** Per notch: the FC's get results (null = not read). */
  values: Record<GyroNotchIndex, { center: NotchGetResult | null; cutoff: NotchGetResult | null }>;
  report: FiltersReportResult | null;
  /** `storage` schema if readable (null = unknown). */
  schema: number | null;
  /** `storage` dirty flag if readable (null = unknown). */
  fcDirty: boolean | null;
  /** The gate's message when a read never reached the FC (queue timeout, cancel, disconnect, busy):
   * those values stay unknown and are never "malformed" or "older firmware". */
  notRead?: string | null;
}

export function emptyNotchSnapshot(): NotchSnapshot {
  return { values: { 1: { center: null, cutoff: null }, 2: { center: null, cutoff: null } }, report: null, schema: null, fcDirty: null };
}

async function readKey(host: NotchHost, key: SettingsKey, snap: NotchSnapshot): Promise<NotchGetResult | null> {
  try {
    const { value } = await host.getSetting(key);
    return Number.isFinite(Number(value)) && value.trim() !== "" ? { kind: "value", value } : { kind: "malformed", raw: value };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Nothing was sent: the FC said nothing, so the value is unknown (not malformed, not unsupported).
    if (isGateNotSent(e)) { snap.notRead ??= msg; return null; }
    return /unknown key/.test(msg) ? { kind: "unsupported" } : { kind: "malformed", raw: msg };
  }
}

/** Read all four keys with `get`, the `filters` report and `storage` (schema/dirty). */
export async function readNotches(host: NotchHost): Promise<NotchSnapshot> {
  const snap = emptyNotchSnapshot();
  for (const i of GYRO_NOTCH_INDEXES) {
    snap.values[i] = { center: await readKey(host, notchCenterKey(i), snap), cutoff: await readKey(host, notchCutoffKey(i), snap) };
  }
  try { snap.report = parseFiltersReport(await host.sendCommand("filters")); } catch (e) { snap.report = null; if (isGateNotSent(e)) snap.notRead ??= e instanceof Error ? e.message : String(e); }
  try {
    const raw = await host.sendCommand("storage");
    const declared = /^schema: (\d+)\r?$/m.exec(raw);
    // An explicitly incompatible format is unsupported, not an unknown schema
    // that would allow legacy settings through the feature-presence fallback.
    if (declared && Number(declared[1]) !== 13) snap.schema = 0;
    else { const st = parseStorage(raw); snap.schema = st.schema; snap.fcDirty = st.dirty; }
  } catch (e) { /* Transport/partial replies remain unknown; do not invent a version. */ if (isGateNotSent(e)) snap.notRead ??= e instanceof Error ? e.message : String(e); }
  return snap;
}

/** Older FC: schema < 8 or keys missing/unsupported. */
export function notchesSupported(snap: NotchSnapshot): boolean {
  if (snap.schema !== null && snap.schema < 8) return false;
  return GYRO_NOTCH_INDEXES.every((i) => snap.values[i].center?.kind === "value" && snap.values[i].cutoff?.kind === "value");
}

export function notchRows(snap: NotchSnapshot): NotchRowView[] {
  const supported = notchesSupported(snap);
  return GYRO_NOTCH_INDEXES.map((i) => {
    const v = notchRowView(i, snap.values[i].center, snap.values[i].cutoff, snap.report);
    return supported ? v : { ...v, supported: false, center: GYRO_NOTCH_UNKNOWN, cutoff: GYRO_NOTCH_UNKNOWN, off: null, cutoffDisabled: true, active: GYRO_NOTCH_UNKNOWN, reason: GYRO_NOTCH_UNKNOWN };
  });
}

/** Editable row: enable toggle + centre + cutoff input strings. */
export interface NotchDraft { enabled: boolean; center: string; cutoff: string; }

/** Draft from the FC values. Off keeps the stored cutoff (never cleared); centre input empty. */
export function draftFromRow(row: NotchRowView): NotchDraft {
  if (!row.supported) return { enabled: false, center: "", cutoff: "" };
  return { enabled: row.off === false, center: row.off === false ? row.center : "", cutoff: row.cutoff };
}

export function loadedPair(row: NotchRowView): NotchPair | null {
  if (!row.supported) return null;
  const c = Number(row.center), f = Number(row.cutoff);
  return Number.isFinite(c) && Number.isFinite(f) ? { center: c, cutoff: f } : null;
}

/** Pair the draft asks for; null when an input is not a number. Off = centre 0, cutoff kept. */
export function draftPair(d: NotchDraft): NotchPair | null {
  const f = d.cutoff.trim() === "" ? NaN : Number(d.cutoff);
  if (!Number.isFinite(f)) return null;
  if (!d.enabled) return { center: 0, cutoff: f };
  const c = d.center.trim() === "" ? NaN : Number(d.center);
  return Number.isFinite(c) ? { center: c, cutoff: f } : null;
}

/** Client-side hint mirroring the FW pair rule (the FC stays the authority). */
export function draftProblem(d: NotchDraft): string | null {
  const p = draftPair(d);
  if (!p) return "Enter numbers.";
  if (d.enabled && p.center === 0) return "Enter a centre (20..1000 Hz) or turn the notch off.";
  return notchPairProblem(p.center, p.cutoff);
}

export function draftDirty(row: NotchRowView, d: NotchDraft): boolean {
  if (!row.supported) return false;
  const cur = loadedPair(row), next = draftPair(d);
  return !cur || !next || cur.center !== next.center || cur.cutoff !== next.cutoff;
}

/** Plain decimal the FW and the allowlist accept (no exponent). */
export function formatNotchValue(n: number): string {
  if (Number.isInteger(n)) return String(n);
  const s = n.toFixed(6).replace(/\.?0+$/, "");
  return s.length ? s : "0";
}

export type ApplyResult = { ok: true; sent: string[] } | { ok: false; sent: string[]; fcLine: string };
/**
 * Send one notch change in the FW-safe order (notchWritePlan).
 * Stops at the first refusal and returns the FC's line verbatim. The caller
 * must re-read (readNotches) afterwards: nothing is updated optimistically.
 */
export async function applyNotch(host: NotchHost, i: GyroNotchIndex, current: NotchPair | null, next: NotchPair): Promise<ApplyResult> {
  const sent: string[] = [];
  for (const step of notchWritePlan(i, current, next)) {
    const value = formatNotchValue(step.value);
    sent.push(`set ${step.key} ${value}`);
    try {
      await host.setSetting(step.key, value);
    } catch (e) {
      return { ok: false, sent, fcLine: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: true, sent };
}

export const DISCARD_EDITS_MESSAGE = "Discard the edits on this page that were not sent to the FC?";

/**
 * Reload guard: local page edits ask first (they would be discarded), then the
 * #54 storage guard (`requestRefresh`) asks when the FC reports dirty=1.
 * Returns whether the reload ran.
 */
export function requestFiltersReload({ pageDirty, fcDirty, confirm, reload, requestRefresh }: {
  pageDirty: boolean;
  fcDirty: boolean | null;
  confirm: (message: string) => boolean;
  reload: () => void;
  requestRefresh: (a: { dirty: boolean; confirm: (m: string) => boolean; refresh: () => void }) => boolean;
}): boolean {
  if (pageDirty && !confirm(DISCARD_EDITS_MESSAGE)) return false;
  return requestRefresh({ dirty: fcDirty === true, confirm, refresh: reload });
}
