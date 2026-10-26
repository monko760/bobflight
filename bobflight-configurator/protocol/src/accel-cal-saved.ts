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
  /** "unknown" when the line is missing, repeated or has a value this client does not know. */
  value: "yes" | "no" | "unknown";
  /** The FC line exactly as received (null when missing or repeated). */
  line: string | null;
}

/** Reads `accel_cal_saved:` from a raw `storage` reply; never throws. */
export function readAccelCalSaved(raw: string): AccelCalSaved {
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\r$/, "")).filter((l) => l.startsWith(ACCEL_CAL_SAVED_PREFIX));
  if (lines.length !== 1) return { value: ACCEL_CAL_SAVED_UNKNOWN, line: null };
  const m = /^accel_cal_saved: (yes|no)$/.exec(lines[0]);
  return { value: m ? (m[1] as "yes" | "no") : ACCEL_CAL_SAVED_UNKNOWN, line: lines[0] };
}
