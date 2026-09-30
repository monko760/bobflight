/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import { formatFwFloat, parseCliFloat } from "./settings";
import { RPM_FILTER_KEYS, isRpmFilterKey, type RpmFilterKey } from "./rpm-filter";
/**
 * Mock FW for the RPM notch filter (same wire as drivers/rpm_filter_cli.h).
 *   off               schema 9 FC, harmonics 0 (default), bidir on, eRPM live, 4 kHz loop
 *   ok                harmonics 3, bidir on, four motors tracked (180/182/179/185 Hz), 4 kHz
 *   bidir-off         harmonics 2 accepted, dshot_bidir off: nothing tracked
 *   erpm-unavailable  harmonics 2, bidir on, no valid telemetry
 *   trimmed-1k        harmonics 3 at a 1 kHz loop: the FC runs 1 harmonic (reason ok)
 *   old-fc            firmware before schema 9: "unknown key", no `rpm_filter`
 *   off-erpm-live     harmonics 0 while `get erpm_mN` answers live values:
 *                     every rpm_filter_mN_hz stays unavailable
 * The mock mirrors the FW rules only to produce FW-identical replies; the UI
 * never computes any of this.
 */
export const RPM_FILTER_MOCK_SCENARIOS = ["off", "ok", "bidir-off", "erpm-unavailable", "trimmed-1k", "old-fc", "off-erpm-live"] as const;
export type RpmFilterMockScenario = (typeof RPM_FILTER_MOCK_SCENARIOS)[number];

const DEFAULTS: Record<RpmFilterKey, number> = { rpm_filter_harmonics: 0, rpm_filter_min_hz: 100, rpm_filter_q_x100: 500, motor_poles: 14 };
const RULES: Record<RpmFilterKey, string> = { rpm_filter_harmonics: "0..3", rpm_filter_min_hz: "50..200", rpm_filter_q_x100: "100..1000", motor_poles: "even, 4..36" };
/** eRPM giving 180/182/179/185 Hz with 14 poles. */
const LIVE_ERPM = [75600, 76440, 75180, 77700] as const;

export class MockRpmFilter {
  private values: Record<RpmFilterKey, number> = { ...DEFAULTS };
  private bidir = true;
  private rateHz = 4000;
  private erpm: readonly number[] = LIVE_ERPM;
  constructor(private scenario: RpmFilterMockScenario = "off") { this.setScenario(scenario); }
  get supported(): boolean { return this.scenario !== "old-fc"; }
  setScenario(s: RpmFilterMockScenario): void {
    this.scenario = s;
    this.defaults();
    this.bidir = s !== "bidir-off";
    this.rateHz = s === "trimmed-1k" ? 1000 : 4000;
    this.erpm = s === "erpm-unavailable" || s === "bidir-off" ? [0, 0, 0, 0] : LIVE_ERPM;
    if (s === "ok" || s === "trimmed-1k") this.values.rpm_filter_harmonics = 3;
    if (s === "bidir-off" || s === "erpm-unavailable") this.values.rpm_filter_harmonics = 2;
  }
  defaults(): void { this.values = { ...DEFAULTS }; }
  snapshot(): Record<RpmFilterKey, string> {
    const out = {} as Record<RpmFilterKey, string>;
    for (const k of RPM_FILTER_KEYS) out[k] = formatFwFloat(this.values[k]);
    return out;
  }
  private reason(): string {
    if (this.values.rpm_filter_harmonics === 0) return "off";
    if (!this.bidir) return "bidir-off";
    return this.erpm.some((e) => e > 0) ? "ok" : "erpm-unavailable";
  }
  report(): string {
    const reason = this.reason(), limit = 0.45 * this.rateHz;
    let allowed = 0;
    for (let h = 1; h <= 3; h++) if (h * 400 < limit) allowed = h;
    const active = reason === "ok" ? Math.min(this.values.rpm_filter_harmonics, allowed) : 0;
    const hz = (m: number) => {
      if (reason !== "ok" || !(this.erpm[m] > 0)) return "unavailable";
      const f = this.erpm[m] / (this.values.motor_poles / 2) / 60;
      return String(Math.floor(Math.max(f, this.values.rpm_filter_min_hz) + 0.5));
    };
    // Frozen FW report: exactly these lines, in this order.
    return `rpm_filter_api: 1\r\nrpm_filter_active: ${reason === "ok" ? "yes" : "no"}\r\nrpm_filter_reason: ${reason}\r\n` +
      `rpm_filter_sample_hz: ${this.rateHz}\r\nrpm_filter_harmonics_active: ${active}\r\n` +
      `rpm_filter_m1_hz: ${hz(0)}\r\nrpm_filter_m2_hz: ${hz(1)}\r\nrpm_filter_m3_hz: ${hz(2)}\r\nrpm_filter_m4_hz: ${hz(3)}\r\nrpm_filter_end: 1\r\n`;
  }
  /** FW-identical reply for an RPM filter line, or null when the line is not ours. */
  handle(line: string, armed: boolean): string | null {
    if (line === "rpm_filter") return this.supported ? this.report() : "unknown — try help\r\n";
    const e = /^get erpm_m([1-4])$/.exec(line);
    if (e && this.scenario === "off-erpm-live") return `erpm_m${e[1]}=${this.erpm[Number(e[1]) - 1]}\r\n`;
    const g = /^get (\S+)$/.exec(line);
    if (g && isRpmFilterKey(g[1])) return this.supported ? `${g[1]}=${formatFwFloat(this.values[g[1]])}\r\n` : "unknown key\r\n";
    const s = /^set (\S+) (.+)$/.exec(line);
    if (!s || !isRpmFilterKey(s[1])) return null;
    if (armed) return "set failed: armed\r\n";
    if (!this.supported) return "unknown key\r\n";
    const key = s[1];
    const v = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(s[2].trim()) ? parseCliFloat(s[2]) : null;
    if (v === null || !Number.isFinite(v) || !Number.isInteger(v)) return "set failed\r\n";
    const ok = key === "rpm_filter_harmonics" ? v >= 0 && v <= 3 : key === "rpm_filter_min_hz" ? v >= 50 && v <= 200
      : key === "rpm_filter_q_x100" ? v >= 100 && v <= 1000 : v >= 4 && v <= 36 && v % 2 === 0;
    if (!ok) return `set failed: ${key} must be ${RULES[key]}\r\n`;
    this.values[key] = v;
    return `ok ${key}=${formatFwFloat(v)}\r\n`;
  }
}
