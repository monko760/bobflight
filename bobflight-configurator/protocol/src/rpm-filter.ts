/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * RPM notch filter (FW config schema 9). Frozen FW contract
 * (bobflight-firmware/src/drivers/rpm_filter_cli.h, flight/rpm_filter.h, flight/config.c):
 *
 *   keys (persisted, whole numbers, printed %.6g):
 *     rpm_filter_harmonics  0..3 (0 = off)      rpm_filter_min_hz  50..200
 *     rpm_filter_q_x100     100..1000 (Q*100)   motor_poles        even 4..36
 *   get <key>   -> "<key>=<v>"                 older FC: "unknown key"
 *   set <key> v -> "ok <key>=<v>" or a line starting "set failed" (shown verbatim):
 *                    set failed: rpm_filter_harmonics must be 0..3
 *                    set failed: rpm_filter_min_hz must be 50..200
 *                    set failed: rpm_filter_q_x100 must be 100..1000
 *                    set failed: motor_poles must be even, 4..36
 *                    set failed            (not a whole number)
 *                    set failed: armed
 *   rpm_filter  -> framed report, frozen (exactly these lines, in this order):
 *                    rpm_filter_api: 1
 *                    rpm_filter_active: yes|no
 *                    rpm_filter_reason: off|ok|bidir-off|erpm-unavailable
 *                    rpm_filter_sample_hz: <int>
 *                    rpm_filter_harmonics_active: <0..3>
 *                    rpm_filter_m1_hz: <int>|unavailable     (m1..m4)
 *                    rpm_filter_end: 1
 *                  older FC: "unknown — try help"
 *                  The harmonics setting is not in the report: `get rpm_filter_harmonics`.
 *
 * The FC is the authority: motor frequencies come only from rpm_filter_mN_hz
 * (never computed from erpm_mN and motor_poles here), the harmonic trim and
 * the reason only from the report. Tokens are kept exactly as sent; a missing,
 * duplicated or malformed field is null ("unknown"). harmonics > 0 never
 * enables bidirectional DShot.
 */
export const RPM_FILTER_KEYS = ["rpm_filter_harmonics", "rpm_filter_min_hz", "rpm_filter_q_x100", "motor_poles"] as const;
export type RpmFilterKey = (typeof RPM_FILTER_KEYS)[number];
export const RPM_FILTER_MOTORS = [1, 2, 3, 4] as const;
export type RpmFilterMotor = (typeof RPM_FILTER_MOTORS)[number];
export const RPM_FILTER_UNKNOWN = "unknown";
/** Reason tokens the FW documents (others are still shown verbatim). */
export const RPM_FILTER_REASONS = ["off", "bidir-off", "erpm-unavailable", "ok"] as const;

export function isRpmFilterKey(k: string): k is RpmFilterKey { return (RPM_FILTER_KEYS as readonly string[]).includes(k); }

/** Allowlisted exact CLI lines for the RPM filter (plain whole numbers only; the FW decides validity). */
export function isRpmFilterCliCommand(cmd: string): boolean {
  if (cmd === "rpm_filter") return true;
  if (/^get (?:rpm_filter_(?:harmonics|min_hz|q_x100)|motor_poles)$/.test(cmd)) return true;
  return /^set (?:rpm_filter_(?:harmonics|min_hz|q_x100)|motor_poles) (?:0|[1-9]\d{0,3})$/.test(cmd);
}

/** Static domain mirror (UI hint only, never the authority). null = inside the domain. */
export function rpmValueProblem(key: RpmFilterKey, n: number): string | null {
  if (!Number.isInteger(n)) return "Use a whole number.";
  if (key === "rpm_filter_harmonics") return n >= 0 && n <= 3 ? null : "Use 0 (off) to 3 harmonics.";
  if (key === "rpm_filter_min_hz") return n >= 50 && n <= 200 ? null : "Use 50 to 200 Hz.";
  if (key === "rpm_filter_q_x100") return n >= 100 && n <= 1000 ? null : "Use Q 1.00 to 10.00.";
  return n >= 4 && n <= 36 && n % 2 === 0 ? null : "Use an even pole count from 4 to 36.";
}

/** Q shown to the user: the integer the FC holds divided by 100, exactly ("500" -> "5"). */
export function qFromX100(v: string): string {
  if (!/^\d+$/.test(v)) return v;
  const n = Number(v);
  const whole = Math.floor(n / 100), frac = n % 100;
  return frac === 0 ? String(whole) : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}`;
}
/** Integer sent for a Q the user typed (at most two decimals); null when it has more precision or is not a number. */
export function qToX100(q: string): number | null {
  const m = /^(\d{1,2})(?:\.(\d{1,2}))?$/.exec(q.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

const lines = (raw: string) => String(raw).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

export type RpmGetResult = { kind: "value"; value: string } | { kind: "unsupported" } | { kind: "malformed"; raw: string };
/** `get <key>`: FW value string kept verbatim; "unknown key" = older FC. */
export function parseRpmGetReply(raw: string, key: RpmFilterKey): RpmGetResult {
  const ls = lines(raw);
  if (ls.length === 1 && ls[0] === "unknown key") return { kind: "unsupported" };
  const m = ls.length === 1 ? /^([a-z0-9_]+)=(\S+)$/.exec(ls[0]) : null;
  if (m && m[1] === key && Number.isFinite(Number(m[2]))) return { kind: "value", value: m[2] };
  return { kind: "malformed", raw: String(raw).trim() };
}

export type RpmSetResult = { ok: true; value: string } | { ok: false; unsupported: boolean; message: string };
/** `set <key> v`: ok only when the FW echoes the key; failures keep the FW line verbatim. */
export function parseRpmSetReply(raw: string, key: RpmFilterKey): RpmSetResult {
  const ls = lines(raw);
  const first = ls[0] ?? "";
  const m = /^ok ([a-z0-9_]+)=(\S+)$/.exec(first);
  if (m && m[1] === key && ls.length === 1) return { ok: true, value: m[2] };
  return { ok: false, unsupported: first === "unknown key", message: first || "no reply" };
}

/** Frozen `rpm_filter` field lines, in wire order (between `rpm_filter_api: 1` and `rpm_filter_end: 1`). */
export const RPM_FILTER_REPORT_FIELDS = [
  "rpm_filter_active", "rpm_filter_reason", "rpm_filter_sample_hz", "rpm_filter_harmonics_active",
  "rpm_filter_m1_hz", "rpm_filter_m2_hz", "rpm_filter_m3_hz", "rpm_filter_m4_hz",
] as const;
export interface RpmFilterReport {
  active: string | null; reason: string | null; sampleHz: string | null; harmonicsActive: string | null;
  motorHz: Record<RpmFilterMotor, string | null>;
}
export type RpmFilterReportResult = { kind: "report"; report: RpmFilterReport } | { kind: "unsupported" } | { kind: "malformed"; raw: string };
/**
 * Framed `rpm_filter` report. Fields must be `<key>: <single token>`; a line
 * with extra words (e.g. "rpm_filter_reason: bidir off") does not parse and
 * the field is null. Duplicates are null. Tokens are never mapped.
 */
export function parseRpmFilterReport(raw: string): RpmFilterReportResult {
  const ls = lines(raw);
  if (ls.length >= 1 && /^unknown\b.*try help$/.test(ls[0]) && !ls.includes("rpm_filter_api: 1")) return { kind: "unsupported" };
  const s = ls.indexOf("rpm_filter_api: 1"), e = ls.lastIndexOf("rpm_filter_end: 1");
  if (s < 0 || e < s) return { kind: "malformed", raw: String(raw).trim() };
  const seen = new Map<string, string>(), dup = new Set<string>();
  for (const l of ls.slice(s + 1, e)) {
    const m = /^([a-z0-9_]+): (\S+)$/.exec(l);
    if (!m) continue;
    if (seen.has(m[1])) dup.add(m[1]);
    seen.set(m[1], m[2]);
  }
  const get = (k: string): string | null => (dup.has(k) ? null : seen.get(k) ?? null);
  return {
    kind: "report",
    report: {
      active: get("rpm_filter_active"), reason: get("rpm_filter_reason"),
      sampleHz: get("rpm_filter_sample_hz"), harmonicsActive: get("rpm_filter_harmonics_active"),
      motorHz: { 1: get("rpm_filter_m1_hz"), 2: get("rpm_filter_m2_hz"), 3: get("rpm_filter_m3_hz"), 4: get("rpm_filter_m4_hz") },
    },
  };
}

/**
 * True only for a report in the exact frozen shape: the framing lines, then
 * the RPM_FILTER_REPORT_FIELDS lines in order with one token each, nothing
 * else (contract tests use it; the UI parser stays per-field tolerant).
 */
export function rpmFilterReportIsExact(raw: string): boolean {
  const ls = String(raw).split(/\r?\n/).filter((l) => l !== "");
  if (ls.length !== RPM_FILTER_REPORT_FIELDS.length + 2 || ls[0] !== "rpm_filter_api: 1" || ls[ls.length - 1] !== "rpm_filter_end: 1") return false;
  return RPM_FILTER_REPORT_FIELDS.every((k, i) => new RegExp(`^${k}: \\S+$`).test(ls[i + 1]));
}

export interface RpmFilterView {
  /** false: older FC (a key or the report missing) — section read-only, everything "unknown". */
  supported: boolean;
  harmonics: string; minHz: string; qX100: string; q: string; motorPoles: string;
  sampleHz: string; harmonicsActive: string; active: string; reason: string;
  /** Reason is exactly bidir-off: point the user at the Motors tab (never auto-enable). */
  bidirOff: boolean;
  /** Per motor: the FC's rpm_filter_mN_hz token verbatim ("unavailable" included), "unknown" if missing. */
  motors: Array<{ motor: RpmFilterMotor; hz: string }>;
}
/**
 * Section display model from the FC's `get` results and parsed report.
 * Nothing is inferred: no Hz from eRPM, no trim from the sample rate, no
 * reason from the settings.
 */
export function rpmFilterView(values: Partial<Record<RpmFilterKey, RpmGetResult | null>>, report: RpmFilterReportResult | null): RpmFilterView {
  const val = (k: RpmFilterKey) => { const r = values[k]; return r?.kind === "value" ? r.value : null; };
  const rep = report?.kind === "report" ? report.report : null;
  const supported = RPM_FILTER_KEYS.every((k) => val(k) !== null) && rep !== null;
  const u = (v: string | null | undefined) => (supported && v ? v : RPM_FILTER_UNKNOWN);
  const qX100 = u(val("rpm_filter_q_x100"));
  return {
    supported,
    harmonics: u(val("rpm_filter_harmonics")), minHz: u(val("rpm_filter_min_hz")), qX100,
    q: qX100 === RPM_FILTER_UNKNOWN ? RPM_FILTER_UNKNOWN : qFromX100(qX100),
    motorPoles: u(val("motor_poles")),
    sampleHz: u(rep?.sampleHz), harmonicsActive: u(rep?.harmonicsActive), active: u(rep?.active), reason: u(rep?.reason),
    bidirOff: supported && rep?.reason === "bidir-off",
    motors: RPM_FILTER_MOTORS.map((motor) => ({ motor, hz: u(rep?.motorHz[motor]) })),
  };
}
