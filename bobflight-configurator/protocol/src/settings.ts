/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FW-locked CLI settings (get/set/save/defaults) + Schema5 Filters R0 LPF.
 * Reply shapes (exact, no spaces around '='):
 *   get ok:      `<key>=<value>\r\n`  — value via snprintf "%.6g"
 *   get unknown: `unknown key\r\n`
 *   set ok:      `ok <key>=<value>\r\n` — after config_set_key + re-get
 *   set unknown: `unknown key\r\n`
 *   set bad:     `set failed\r\n`
 *   save ok:     `saved\r\n` / host: `saved: flash verified\r\n`
 *   save fail:   `save failed\r\n`
 *   defaults:    `defaults restored\r\n` (does not auto-save)
 *
 * Validation (config.c config_set_key):
 *   rate_max_*: 10..2000
 *   rate_expo:  0..1
 *   other pid_*: 0..10, must be finite
 *   gyro_lpf_hz / dterm_lpf_hz: 0=off else 10..1000 — FW Lead+Flight lock 2026-09-22
 *   min_throttle: 0..0.2; airmode: 0|1
 */

/** Filters R0 / Schema 5 float keys (no notches). FW Lead+Flight lock 2026-09-22. */
export const SCHEMA5_FLOAT_KEYS = ["gyro_lpf_hz", "dterm_lpf_hz"] as const;

export type Schema5FloatKey = (typeof SCHEMA5_FLOAT_KEYS)[number];

/**
 * Float get/set keys: first-12 PID/rate + Gate2 min_throttle/airmode + Schema5 LPF.
 */
export const SETTINGS_KEYS = [
  "rate_max_roll",
  "rate_max_pitch",
  "rate_max_yaw",
  "rate_expo",
  "pid_roll_p",
  "pid_roll_i",
  "pid_roll_d",
  "pid_pitch_p",
  "pid_pitch_i",
  "pid_pitch_d",
  "pid_yaw_p",
  "pid_yaw_i",
  "min_throttle",
  "airmode",
  ...SCHEMA5_FLOAT_KEYS,
] as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[number];

export function isSettingsKey(k: string): k is SettingsKey {
  return (SETTINGS_KEYS as readonly string[]).includes(k);
}

/**
 * Approximate C `snprintf(..., "%.6g", n)` closely enough for FW CLI values.
 * Matches glibc for FW defaults: 800 → "800", 0.30 → "0.3", 5e-5 → "5e-05".
 */
export function formatFwFloat(n: number): string {
  if (!Number.isFinite(n)) {
    return String(n);
  }
  if (n === 0) {
    return "0";
  }
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const precision = 6;

  let exp = Math.floor(Math.log10(abs));
  let mant = abs * Math.pow(10, -exp);
  if (mant >= 10 - 1e-12) {
    mant /= 10;
    exp += 1;
  } else if (mant < 1) {
    mant *= 10;
    exp -= 1;
  }

  const roundFactor = Math.pow(10, precision - 1);
  let rMant = Math.round(mant * roundFactor) / roundFactor;
  if (rMant >= 10) {
    rMant /= 10;
    exp += 1;
  }

  const rounded = rMant * Math.pow(10, exp);

  if (exp < -4 || exp >= precision) {
    let mantStr = rMant.toFixed(precision - 1);
    if (mantStr.includes(".")) {
      mantStr = mantStr.replace(/\.?0+$/, "");
    }
    const expSign = exp >= 0 ? "+" : "-";
    const expAbs = Math.abs(exp);
    const expStr = expAbs < 10 ? `0${expAbs}` : String(expAbs);
    return `${sign}${mantStr}e${expSign}${expStr}`;
  }

  const decimals = Math.max(0, precision - 1 - exp);
  let s = rounded.toFixed(decimals);
  if (s.includes(".")) {
    s = s.replace(/\.?0+$/, "");
  }
  return `${sign}${s}`;
}

/** Numeric DEF_* from FW config.c (store as numbers internally). */
export const DEFAULT_SETTING_VALUES: Readonly<Record<SettingsKey, number>> = {
  rate_max_roll: 800,
  rate_max_pitch: 800,
  rate_max_yaw: 800,
  rate_expo: 0.3, // DEF_EXPO 0.30f
  pid_roll_p: 0.002,
  pid_roll_i: 0.001,
  pid_roll_d: 0.00005,
  pid_pitch_p: 0.002,
  pid_pitch_i: 0.001,
  pid_pitch_d: 0.00005,
  pid_yaw_p: 0.002,
  pid_yaw_i: 0.001,
  min_throttle: 0.05,
  airmode: 0,
  // Schema5 Filters R0 — FW Lead+Flight lock 2026-09-22
  gyro_lpf_hz: 320,
  dterm_lpf_hz: 53,
};

/**
 * Canonical get/set display strings (FW %.6g).
 * Verified vs glibc: 800, 0.3, 0.002, 0.001, 5e-05.
 */
export const DEFAULT_SETTINGS: Readonly<Record<SettingsKey, string>> = {
  rate_max_roll: formatFwFloat(DEFAULT_SETTING_VALUES.rate_max_roll),
  rate_max_pitch: formatFwFloat(DEFAULT_SETTING_VALUES.rate_max_pitch),
  rate_max_yaw: formatFwFloat(DEFAULT_SETTING_VALUES.rate_max_yaw),
  rate_expo: formatFwFloat(DEFAULT_SETTING_VALUES.rate_expo),
  pid_roll_p: formatFwFloat(DEFAULT_SETTING_VALUES.pid_roll_p),
  pid_roll_i: formatFwFloat(DEFAULT_SETTING_VALUES.pid_roll_i),
  pid_roll_d: formatFwFloat(DEFAULT_SETTING_VALUES.pid_roll_d),
  pid_pitch_p: formatFwFloat(DEFAULT_SETTING_VALUES.pid_pitch_p),
  pid_pitch_i: formatFwFloat(DEFAULT_SETTING_VALUES.pid_pitch_i),
  pid_pitch_d: formatFwFloat(DEFAULT_SETTING_VALUES.pid_pitch_d),
  pid_yaw_p: formatFwFloat(DEFAULT_SETTING_VALUES.pid_yaw_p),
  pid_yaw_i: formatFwFloat(DEFAULT_SETTING_VALUES.pid_yaw_i),
  min_throttle: formatFwFloat(DEFAULT_SETTING_VALUES.min_throttle),
  airmode: formatFwFloat(DEFAULT_SETTING_VALUES.airmode),
  gyro_lpf_hz: formatFwFloat(DEFAULT_SETTING_VALUES.gyro_lpf_hz),
  dterm_lpf_hz: formatFwFloat(DEFAULT_SETTING_VALUES.dterm_lpf_hz),
};

export function cloneDefaultSettings(): Record<SettingsKey, string> {
  return { ...DEFAULT_SETTINGS };
}

export function cloneDefaultSettingValues(): Record<SettingsKey, number> {
  return { ...DEFAULT_SETTING_VALUES };
}

/** FW config_set_key range checks (after finite check). */
export function validateSettingValue(key: SettingsKey, value: number): boolean {
  if (!Number.isFinite(value)) {
    return false;
  }
  if (key.startsWith("rate_max_")) {
    return value >= 10 && value <= 2000;
  }
  if (key === "rate_expo") {
    return value >= 0 && value <= 1;
  }
  if (key === "min_throttle") {
    return value >= 0 && value <= 0.2;
  }
  if (key === "airmode") {
    return value === 0 || value === 1;
  }
  // Schema5 Filters R0 — FW Lead+Flight lock 2026-09-22: 0=off else 10..1000
  if (key === "gyro_lpf_hz" || key === "dterm_lpf_hz") {
    if (value === 0) return true;
    return value >= 10 && value <= 1000;
  }
  // pid_* and any other known key: 0..10
  return value >= 0 && value <= 10;
}

/**
 * Parse a CLI float token like FW strtof: non-numeric → null (set failed).
 * Leading-parse only (trailing junk after a number is accepted, as in strtof).
 */
export function parseCliFloat(token: string): number | null {
  const s = token.trim();
  if (s.length === 0) {
    return null;
  }
  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) {
    return null;
  }
  // Reject when first non-space char is not part of a number start (parseFloat
  // allows "Infinity"; FW strtof may too — still fail via !isfinite in validate).
  return n;
}

export interface ParsedGetReply {
  ok: boolean;
  key?: string;
  value?: string;
  /** True when reply was `unknown key`. */
  unknown?: boolean;
  raw: string;
}

export interface ParsedSetReply {
  ok: boolean;
  key?: string;
  value?: string;
  /** True when reply was `unknown key`. */
  unknown?: boolean;
  /** True when reply was `set failed`. */
  failed?: boolean;
  raw: string;
}

/**
 * Parse a get reply. Exact ok shape: `key=value` (optional surrounding whitespace/CRLF).
 * Value token is anything after `=` (parsers stay tolerant of %.6g forms).
 */
export function parseGetReply(raw: string): ParsedGetReply {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text === "unknown key") {
    return { ok: false, unknown: true, raw };
  }
  const m = /^([A-Za-z0-9_]+)=(.+)$/.exec(text);
  if (!m) {
    return { ok: false, raw };
  }
  return { ok: true, key: m[1], value: m[2], raw };
}

/**
 * Parse a set reply. Exact ok shape: `ok key=value`.
 */
export function parseSetReply(raw: string): ParsedSetReply {
  const text = raw.replace(/\r\n/g, "\n").trim();
  if (text === "unknown key") {
    return { ok: false, unknown: true, raw };
  }
  if (text === "set failed") {
    return { ok: false, failed: true, raw };
  }
  const m = /^ok\s+([A-Za-z0-9_]+)=(.+)$/.exec(text);
  if (!m) {
    return { ok: false, raw };
  }
  return { ok: true, key: m[1], value: m[2], raw };
}

/** True only for an explicitly verified controller flash acknowledgment. */
export function parseSaveReply(raw: string): { ok: boolean; raw: string } {
  const text = raw.replace(/\r\n/g, "\n").trim();
  return { ok: text === "saved: flash verified", raw };
}

/** True when defaults reply is exactly `defaults restored`. */
export function parseDefaultsReply(raw: string): {
  ok: boolean;
  raw: string;
} {
  const text = raw.replace(/\r\n/g, "\n").trim();
  return { ok: text === "defaults restored", raw };
}
