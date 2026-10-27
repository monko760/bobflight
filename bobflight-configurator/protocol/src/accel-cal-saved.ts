/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * D1: the FW `storage` reply carries `accel_cal_saved: yes|no` just before
 * `storage_end: 1` (persist_accel_calibration_saved: the saved record holds an
 * accelerometer calibration). Saving after a board-alignment change drops it
 * (documented FW rule) and the save reply does not say so, so the UI shows
 * this line verbatim next to Save.
 *
 * Kept apart from parseStorage on purpose: the StorageSnapshot stays byte-for-
 * byte what older firmware produced (tests/storage-accel-cal-saved.cjs).
 */
export const ACCEL_CAL_SAVED_PREFIX = "accel_cal_saved:";
export const ACCEL_CAL_SAVED_UNKNOWN = "unknown";

export interface AccelCalSaved {
  /** "unknown" unless exactly one `accel_cal_saved: yes|no` line (byte-exact) came before `storage_end`. */
  value: "yes" | "no" | "unknown";
  /** The FC line exactly as received (null when missing or repeated). */
  line: string | null;
  /** Why the value is unknown (absent when known). */
  reason?: "missing" | "repeated" | "unrecognised";
}

/** Reads `accel_cal_saved:` from a raw `storage` reply; lines after `storage_end` do not count. Never throws. */
export function readAccelCalSaved(raw: string): AccelCalSaved {
  const all = raw.split(/\r?\n/).map((l) => l.replace(/\r$/, ""));
  const end = all.findIndex((l) => /^storage_end:/.test(l));
  const lines = (end >= 0 ? all.slice(0, end) : all).filter((l) => l.startsWith(ACCEL_CAL_SAVED_PREFIX));
  if (lines.length === 0) return { value: ACCEL_CAL_SAVED_UNKNOWN, line: null, reason: "missing" };
  if (lines.length > 1) return { value: ACCEL_CAL_SAVED_UNKNOWN, line: null, reason: "repeated" };
  if (lines[0] === "accel_cal_saved: yes") return { value: "yes", line: lines[0] };
  if (lines[0] === "accel_cal_saved: no") return { value: "no", line: lines[0] };
  return { value: ACCEL_CAL_SAVED_UNKNOWN, line: lines[0], reason: "unrecognised" };
}
