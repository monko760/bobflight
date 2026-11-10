/* SPDX-License-Identifier: Apache-2.0 */
import { parseStorage, validateSettingValue, type StorageSnapshot } from "../protocol";
import { FILTER_KEYS, PID_KEYS } from "./mockSettingsApi";
import type { FiltersConfig, PidConfig } from "./mockTuningStore";

/**
 * Blank input stays NaN. `Number("")` is 0, and that must not be stored:
 * 0 is legal only when the user actually entered 0.
 */
export function numberFromInput(raw: string): number {
  return raw.trim() === "" ? NaN : Number(raw);
}

export function pidDraftValid(v: PidConfig): boolean {
  return PID_KEYS.every((k) => validateSettingValue(k, v[k]));
}

export function filterDraftValid(v: FiltersConfig): boolean {
  return FILTER_KEYS.every((k) => validateSettingValue(k, v[k]));
}

export function storageSnapshotFromRaw(raw: string | undefined | null): StorageSnapshot | null {
  if (!raw) return null;
  try { return parseStorage(raw); } catch { return null; }
}

/** Shown when a save already sent one or more `set` calls and then failed. */
export const MID_SAVE_APPLIED = "Some values may already be applied in RAM or saved. Reload before retrying.";

export function withMidSave(line: string): string {
  return `${line}. ${MID_SAVE_APPLIED}`;
}

export function midSaveFailure(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : String(cause);
  return withMidSave(msg);
}
