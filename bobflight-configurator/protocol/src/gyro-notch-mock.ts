/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import { formatFwFloat, parseCliFloat } from "./settings";
import { GYRO_NOTCH_KEYS, isGyroNotchKey, type GyroNotchKey } from "./gyro-notch";
/**
 * Mock FW for the manual gyro notches (same wire as drivers/filters_cli.h).
 *   off            schema 8 FC, both notches off (default), 4 kHz loop
 *   ok             notch1 200/150 active, notch2 off, 4 kHz loop
 *   above-nyquist  notch1 600/420 stored, 1 kHz applied loop: disabled at runtime
 *   invalid        notch1 200/150 stored but the FC reports it unusable (invalid)
 *   old-fc         firmware before schema 8: "unknown key", no `filters`
 * Only the firmware decides the Nyquist limit; the mock mirrors its rule
 * (centre < 0.45 * running rate) to produce FW-identical replies.
 */
export const GYRO_NOTCH_MOCK_SCENARIOS = ["off", "ok", "above-nyquist", "invalid", "old-fc"] as const;
export type GyroNotchMockScenario = (typeof GYRO_NOTCH_MOCK_SCENARIOS)[number];

export class MockGyroNotch {
  private values: Record<GyroNotchKey, number> = { gyro_notch1_hz: 0, gyro_notch1_cutoff_hz: 0, gyro_notch2_hz: 0, gyro_notch2_cutoff_hz: 0 };
  /* Kakute default loop 4000 (8000/2): the gyro filter runs on every gyro
   * sample since safety S1, so the FW reports filters_sample_hz 8000. */
  private rateHz = 8000;
  constructor(private scenario: GyroNotchMockScenario = "off") { this.setScenario(scenario); }
  get supported(): boolean { return this.scenario !== "old-fc"; }
  setScenario(s: GyroNotchMockScenario): void {
    this.scenario = s;
    this.defaults();
    this.rateHz = s === "above-nyquist" ? 1000 : 8000;
    if (s === "ok" || s === "invalid") { this.values.gyro_notch1_cutoff_hz = 150; this.values.gyro_notch1_hz = 200; }
    if (s === "above-nyquist") { this.values.gyro_notch1_cutoff_hz = 420; this.values.gyro_notch1_hz = 600; }
  }
  defaults(): void { for (const k of GYRO_NOTCH_KEYS) this.values[k] = 0; }
  snapshot(): Record<GyroNotchKey, string> {
    const out = {} as Record<GyroNotchKey, string>;
    for (const k of GYRO_NOTCH_KEYS) out[k] = formatFwFloat(this.values[k]);
    return out;
  }
  private reason(i: 1 | 2): string {
    const c = this.values[i === 1 ? "gyro_notch1_hz" : "gyro_notch2_hz"], f = this.values[i === 1 ? "gyro_notch1_cutoff_hz" : "gyro_notch2_cutoff_hz"];
    if (c === 0) return "off";
    if (this.scenario === "invalid" && i === 1) return "invalid";
    if (!(c >= 20 && c <= 1000 && f > 0 && f < c)) return "invalid";
    return c < 0.45 * this.rateHz ? "ok" : "above-nyquist";
  }
  report(): string {
    const r1 = this.reason(1), r2 = this.reason(2);
    return `filters_api: 1\r\nfilters_sample_hz: ${this.rateHz}\r\ngyro_notch1_active: ${r1 === "ok" ? "yes" : "no"}\r\ngyro_notch1_reason: ${r1}\r\n` +
      `gyro_notch2_active: ${r2 === "ok" ? "yes" : "no"}\r\ngyro_notch2_reason: ${r2}\r\nfilters_end: 1\r\n`;
  }
  /** FW-identical reply for a notch line, or null when the line is not ours. */
  handle(line: string, armed: boolean): string | null {
    if (line === "filters") return this.supported ? this.report() : "unknown — try help\r\n";
    const g = /^get (\S+)$/.exec(line);
    if (g && isGyroNotchKey(g[1])) return this.supported ? `${g[1]}=${formatFwFloat(this.values[g[1]])}\r\n` : "unknown key\r\n";
    const s = /^set (\S+) (.+)$/.exec(line);
    if (!s || !isGyroNotchKey(s[1])) return null;
    if (armed) return "set failed: armed\r\n";
    if (!this.supported) return "unknown key\r\n";
    const key = s[1], idx = key[10], ck = `gyro_notch${idx}_hz` as GyroNotchKey, fk = `gyro_notch${idx}_cutoff_hz` as GyroNotchKey;
    const v = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s[2].trim()) ? parseCliFloat(s[2]) : null;
    if (v === null || !Number.isFinite(v)) return "set failed\r\n";
    if (key === ck) {
      if (v !== 0 && (v < 20 || v > 1000)) return `set failed: ${ck} must be 0 or 20..1000\r\n`;
      const f = this.values[fk];
      if (v !== 0 && !(f > 0 && f < v)) return `set failed: ${ck} needs 0 < ${fk} < ${ck} (set the cutoff first)\r\n`;
      const limit = 0.45 * this.rateHz;
      if (v !== 0 && !(v < limit)) return `set failed: ${ck} must be below ${formatFwFloat(limit)} Hz at the running ${this.rateHz} Hz loop rate\r\n`;
    } else {
      const c = this.values[ck];
      const ok = c === 0 ? v >= 0 && v < 1000 : v > 0 && v < c;
      if (!ok) return c !== 0 ? `set failed: ${fk} must be > 0 and < ${ck}\r\n` : `set failed: ${fk} must be >= 0 and < 1000 while ${ck} is 0\r\n`;
    }
    this.values[key] = Math.fround(v);
    return `ok ${key}=${formatFwFloat(this.values[key])}\r\n`;
  }
}
