/**
 * FALLBACK ONLY — local mock FW settings CLI when Protocol host settings
 * throw / are unavailable. RatesPage/PidPage/FiltersPage prefer BobFlightHost
 * getSetting/setSetting/saveSettings/restoreDefaults/getAllSettings.
 *
 * Lead-locked reply shapes (no spaces around `=`):
 *   get  → key=value
 *   set  → ok key=value
 *   save → saved
 *   defaults → defaults restored
 * Errors: unknown key | set failed | save failed
 */

import {
  getFilters,
  getPid,
  getRates,
  FILTERS_DEFAULTS,
  PID_DEFAULTS,
  RATES_DEFAULTS,
  resetFilters,
  resetPid,
  resetRates,
  setFilters,
  setPid,
  setRates,
  type FiltersConfig,
  type PidConfig,
  type RatesConfig,
} from "./mockTuningStore";

export const RATE_KEYS = [
  "rate_max_roll",
  "rate_max_pitch",
  "rate_max_yaw",
  "rate_expo",
] as const;

export const PID_KEYS = [
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
] as const;

/** Filters R0 (Schema5) — also in Protocol SETTINGS_KEYS. */
export const FILTER_KEYS = ["gyro_lpf_hz", "dterm_lpf_hz"] as const;

export type RateKey = (typeof RATE_KEYS)[number];
export type PidKey = (typeof PID_KEYS)[number];
export type FilterKey = (typeof FILTER_KEYS)[number];
export type SettingsKey = RateKey | PidKey | FilterKey;

const ALL_KEYS: readonly SettingsKey[] = [
  ...RATE_KEYS,
  ...PID_KEYS,
  ...FILTER_KEYS,
];

function isSettingsKey(k: string): k is SettingsKey {
  return (ALL_KEYS as readonly string[]).includes(k);
}

function formatNum(n: number): string {
  // Compact, stable; no spaces around '=' in the final reply.
  if (Number.isInteger(n)) return String(n);
  // Trim trailing zeros without scientific notation for tiny PID values.
  const s = n.toFixed(8).replace(/\.?0+$/, "");
  return s.length ? s : "0";
}

/**
 * FW lock for filter Hz: 0 = off; else 10..1000 inclusive.
 * Non-finite → invalid.
 */
export function validateFilterHz(value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if (value === 0) return true;
  return value >= 10 && value <= 1000;
}

function readValue(key: SettingsKey): number {
  if ((RATE_KEYS as readonly string[]).includes(key)) {
    return getRates()[key as RateKey];
  }
  if ((FILTER_KEYS as readonly string[]).includes(key)) {
    return getFilters()[key as FilterKey];
  }
  return getPid()[key as PidKey];
}

function writeValue(key: SettingsKey, value: number): boolean {
  if (!Number.isFinite(value)) return false;
  if ((RATE_KEYS as readonly string[]).includes(key)) {
    const next: RatesConfig = { ...getRates(), [key]: value };
    setRates(next);
    return true;
  }
  if ((FILTER_KEYS as readonly string[]).includes(key)) {
    if (!validateFilterHz(value)) return false;
    const next: FiltersConfig = { ...getFilters(), [key]: value };
    setFilters(next);
    return true;
  }
  const next: PidConfig = { ...getPid(), [key]: value };
  setPid(next);
  return true;
}

/** Parse `key=value` (no spaces). Returns null if malformed. */
export function parseKeyValue(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  const idx = trimmed.indexOf("=");
  if (idx <= 0) return null;
  const key = trimmed.slice(0, idx);
  const value = trimmed.slice(idx + 1);
  if (!key || value.includes("=") === false && value.length === 0 && trimmed.endsWith("=") === false) {
    // allow empty? FW shouldn't; treat empty as invalid
  }
  if (!key || value === "") return null;
  // Reject spaces around '='
  if (/\s/.test(key) || line.includes(" =") || line.includes("= ")) return null;
  return { key, value };
}

export function parseGetReply(reply: string): { key: string; value: number } | null {
  const line = reply.trim().split(/\r?\n/)[0] ?? "";
  if (line === "unknown key" || line === "set failed" || line === "save failed") {
    return null;
  }
  const kv = parseKeyValue(line);
  if (!kv) return null;
  const n = Number(kv.value);
  if (!Number.isFinite(n)) return null;
  return { key: kv.key, value: n };
}

export function parseSetReply(
  reply: string,
): { ok: true; key: string; value: number } | { ok: false; error: string } {
  const line = reply.trim().split(/\r?\n/)[0] ?? "";
  if (line === "unknown key" || line === "set failed" || line === "save failed") {
    return { ok: false, error: line };
  }
  if (!line.startsWith("ok ")) {
    return { ok: false, error: line || "set failed" };
  }
  const kv = parseKeyValue(line.slice(3));
  if (!kv) return { ok: false, error: "set failed" };
  const n = Number(kv.value);
  if (!Number.isFinite(n)) return { ok: false, error: "set failed" };
  return { ok: true, key: kv.key, value: n };
}

/** FALLBACK mock settings CLI — do not use as primary path. */
export const mockSettingsApi = {
  get(key: string): string {
    if (!isSettingsKey(key)) return "unknown key";
    return `${key}=${formatNum(readValue(key))}`;
  },

  set(key: string, value: number | string): string {
    if (!isSettingsKey(key)) return "unknown key";
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n)) return "set failed";
    if (!writeValue(key, n)) return "set failed";
    return `ok ${key}=${formatNum(readValue(key))}`;
  },

  save(): string {
    // Mock: state already in memory; always succeed (includes filter keys).
    return "saved";
  },

  defaults(scope: "rates" | "pid" | "filters" | "all" = "all"): string {
    if (scope === "rates" || scope === "all") resetRates();
    if (scope === "pid" || scope === "all") resetPid();
    if (scope === "filters" || scope === "all") resetFilters();
    return "defaults restored";
  },

  /** Fetch all known keys via get replies. */
  getAll(keys: readonly SettingsKey[]): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of keys) {
      const parsed = parseGetReply(this.get(key));
      if (parsed) out[parsed.key] = parsed.value;
    }
    return out;
  },

  defaultsSnapshot(): {
    rates: RatesConfig;
    pid: PidConfig;
    filters: FiltersConfig;
  } {
    return {
      rates: { ...RATES_DEFAULTS },
      pid: { ...PID_DEFAULTS },
      filters: { ...FILTERS_DEFAULTS },
    };
  },
};
