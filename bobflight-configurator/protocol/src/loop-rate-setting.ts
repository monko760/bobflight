/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Persisted loop-rate setting (FW CLI setting `loop_rate_hz`, config schema 7).
 * Frozen FW contract (bobflight-firmware/src/sched/loop_rate_setting.h, drivers/cli.c):
 *
 *   get loop_rate_hz          -> "loop_rate_hz=<1000|4000|8000>"      older FC: "unknown key"
 *   set loop_rate_hz <v>      -> "ok loop_rate_hz=<v>" + "note: loop_rate_hz takes effect after save + reboot"
 *                                "set failed: loop_rate_hz must be 1000, 4000 or 8000"
 *                                "set failed: loop_rate_hz <v> not supported on <board> (no 8 kHz gyro path)"
 *                                "set failed: armed"
 *   loop_rate                 -> framed report ending "loop_rate_end: 1" with
 *                                loop_rate_setting_hz / loop_rate_boot_setting_hz / loop_rate_pending_reboot
 *
 * Mapping (FW): 1000 = gyro 1000 / denom 1, 4000 = 8000 / 2, 8000 = 8000 / 1.
 * The setting is applied at boot only. The rate actually running is status
 * `loop_target_hz` (see loop-rate.ts); it may be lower than the setting when
 * the FW applies a documented fallback, reported as loop_rate_reason.
 * Values stay the FW's exact decimal strings; nothing here computes a rate.
 */
export const LOOP_RATE_SETTING_KEY = "loop_rate_hz";
/** Exactly the three FW-accepted values, in selector order. */
export const LOOP_RATE_OPTIONS = ["1000", "4000", "8000"] as const;
export type LoopRateOption = (typeof LOOP_RATE_OPTIONS)[number];
export const LOOP_RATE_OPTION_LABELS: Record<LoopRateOption, string> = { "1000": "1 kHz", "4000": "4 kHz", "8000": "8 kHz" };
export const LOOP_RATE_REBOOT_NOTE = "note: loop_rate_hz takes effect after save + reboot";
/** Exact FW refusal lines (drivers/cli.c cmd_set); the mocks print these and the UI shows them verbatim. */
export const LOOP_RATE_ARMED_LINE = "set failed: armed";
export const LOOP_RATE_INVALID_LINE = "set failed: loop_rate_hz must be 1000, 4000 or 8000";
/** FW: "set failed: loop_rate_hz %lu not supported on %s (no 8 kHz gyro path)" with the board id. */
export function loopRateUnsupportedLine(value: LoopRateOption, boardId: string): string {
  return `set failed: loop_rate_hz ${value} not supported on ${boardId} (no 8 kHz gyro path)`;
}
export type LoopRateCliCommand = "get loop_rate_hz" | `set loop_rate_hz ${LoopRateOption}` | "loop_rate";
export const LOOP_RATE_CLI_COMMANDS: readonly LoopRateCliCommand[] = [
  "get loop_rate_hz", "set loop_rate_hz 1000", "set loop_rate_hz 4000", "set loop_rate_hz 8000", "loop_rate",
] as const;

export function isLoopRateOption(v: unknown): v is LoopRateOption {
  return typeof v === "string" && (LOOP_RATE_OPTIONS as readonly string[]).includes(v);
}
export function isLoopRateCliCommand(cmd: string): cmd is LoopRateCliCommand {
  return (LOOP_RATE_CLI_COMMANDS as readonly string[]).includes(cmd);
}
export function loopRateSetCommand(v: LoopRateOption): LoopRateCliCommand {
  if (!isLoopRateOption(v)) throw new Error(`unsupported loop rate: ${String(v)}`);
  return `set ${LOOP_RATE_SETTING_KEY} ${v}`;
}

const lines = (raw: string) => String(raw).split(/\r?\n/).map(l => l.trim()).filter(Boolean);

/** `get loop_rate_hz`: value, older FC without the setting, or anything else (malformed). */
export type LoopRateGetResult =
  | { kind: "value"; value: LoopRateOption }
  | { kind: "unsupported" }
  | { kind: "malformed"; raw: string };
export function parseLoopRateGetReply(raw: string): LoopRateGetResult {
  const ls = lines(raw);
  if (ls.length === 1 && ls[0] === "unknown key") return { kind: "unsupported" };
  const m = ls.length === 1 ? /^loop_rate_hz=(\S+)$/.exec(ls[0]) : null;
  if (m && isLoopRateOption(m[1])) return { kind: "value", value: m[1] };
  return { kind: "malformed", raw: String(raw).trim() };
}

export type LoopRateSetFailure = "invalid" | "unsupported-board" | "armed" | "unknown-key" | "unexpected";
export type LoopRateSetResult =
  | { ok: true; value: LoopRateOption; rebootRequired: boolean }
  | { ok: false; reason: LoopRateSetFailure; message: string };
/** `set loop_rate_hz <requested>`: accepted only when the FW echoes exactly the requested value. */
export function parseLoopRateSetReply(raw: string, requested: LoopRateOption): LoopRateSetResult {
  const ls = lines(raw);
  const first = ls[0] ?? "";
  const ok = /^ok loop_rate_hz=(\S+)$/.exec(first);
  if (ok && ok[1] === requested && ls.every((l, i) => i === 0 || l === LOOP_RATE_REBOOT_NOTE) && ls.length <= 2)
    return { ok: true, value: requested, rebootRequired: ls.includes(LOOP_RATE_REBOOT_NOTE) };
  const message = ls.join(" ") || "no reply";
  if (first === "unknown key") return { ok: false, reason: "unknown-key", message: "This firmware has no loop_rate_hz setting (older FC)." };
  if (first === LOOP_RATE_ARMED_LINE) return { ok: false, reason: "armed", message: first };
  if (first === LOOP_RATE_INVALID_LINE) return { ok: false, reason: "invalid", message: first };
  if (/^set failed: loop_rate_hz \d+ not supported on /.test(first)) return { ok: false, reason: "unsupported-board", message: first };
  return { ok: false, reason: "unexpected", message };
}

/** Framed `loop_rate` report. Any field that is absent, duplicated or malformed is null (unknown). */
export interface LoopRateReport {
  settingHz: LoopRateOption | null;
  bootSettingHz: LoopRateOption | null;
  pendingReboot: boolean | null;
  profile: string | null;
  active: string | null;
  reason: string | null;
  guardLevel: string | null;
}
export function parseLoopRateReport(raw: string): LoopRateReport | null {
  const ls = lines(raw);
  if (!ls.includes("loop_rate_api: 1") || ls[ls.length - 1] !== "loop_rate_end: 1") return null;
  const seen = new Map<string, string>(); const dup = new Set<string>();
  for (const l of ls) {
    const m = /^(loop_rate_[a-z_]+): (\S+)$/.exec(l);
    if (!m) continue;
    if (seen.has(m[1])) dup.add(m[1]);
    seen.set(m[1], m[2]);
  }
  const get = (k: string, re: RegExp): string | null => { const v = seen.get(k); return v === undefined || dup.has(k) || !re.test(v) ? null : v; };
  const option = (k: string): LoopRateOption | null => { const v = get(k, /^\d+$/); return isLoopRateOption(v) ? v : null; };
  const pending = get("loop_rate_pending_reboot", /^[01]$/);
  return {
    settingHz: option("loop_rate_setting_hz"),
    bootSettingHz: option("loop_rate_boot_setting_hz"),
    pendingReboot: pending === null ? null : pending === "1",
    profile: get("loop_rate_profile", /^[1-9]\d*\/[1-9]\d*$/),
    active: get("loop_rate_active", /^[1-9]\d*\/[1-9]\d*$/),
    reason: get("loop_rate_reason", /^[a-z0-9-]+$/),
    guardLevel: get("loop_rate_guard_level", /^(?:0|[1-9]\d*)$/),
  };
}

export const LOOP_RATE_SETTING_UNKNOWN = "unknown";
export interface LoopRateSettingView {
  /** Selected value from `get loop_rate_hz`; null = unknown (older FC or no reading). */
  selected: LoopRateOption | null;
  display: string;
  /** false: older FC without the setting; the selector stays disabled. */
  supported: boolean | null;
  pendingReboot: boolean;
  /** `loop_rate_boot_setting_hz` from the FW loop_rate report (the setting applied at boot), or "unknown". */
  bootDisplay: string;
  notices: string[];
}
/**
 * Display model. `targetHz` is status `loop_target_hz` exactly as sent (the
 * rate actually applied); it is only compared, never computed or defaulted.
 */
export function loopRateSettingView(get: LoopRateGetResult | null, report: LoopRateReport | null, targetHz: string | null): LoopRateSettingView {
  const notices: string[] = [];
  const selected = get?.kind === "value" ? get.value : null;
  const supported = get === null ? null : get.kind === "unsupported" ? false : get.kind === "value" ? true : null;
  if (get?.kind === "unsupported") notices.push("This firmware does not report a loop-rate setting (older FC): unknown.");
  if (get?.kind === "malformed") notices.push("Loop-rate setting reply was not understood: unknown.");
  const boot = report?.bootSettingHz ?? null;
  const pendingReboot = !!(selected && (report?.pendingReboot === true || (boot !== null && boot !== selected)));
  if (supported === true && report === null)
    notices.push("Loop-rate report was not understood: pending reboot and firmware fallback are unknown.");
  if (pendingReboot) notices.push(`Pending: ${LOOP_RATE_OPTION_LABELS[selected!]} is selected; the controller runs its boot setting${boot ? ` (${LOOP_RATE_OPTION_LABELS[boot]})` : ""} until you Save and reboot.`);
  else if (supported === true) notices.push("A loop-rate change takes effect after Save + reboot.");
  // A fallback is reported even while a change is pending: it compares the applied
  // target with the boot setting, which a pending (RAM) change does not alter.
  const reason = report?.reason ?? null;
  if (boot !== null && targetHz !== null && targetHz !== boot) {
    notices.push(`Firmware is running ${targetHz} Hz instead of its boot setting ${boot} Hz (${reason ?? "reason unknown"}).`);
  } else if (reason !== null && reason !== "setting") {
    notices.push(`Firmware reports a loop-rate fallback: ${reason}.`);
  }
  const bootDisplay = boot ? LOOP_RATE_OPTION_LABELS[boot] : LOOP_RATE_SETTING_UNKNOWN;
  return { selected, display: selected ? LOOP_RATE_OPTION_LABELS[selected] : LOOP_RATE_SETTING_UNKNOWN, supported, pendingReboot, bootDisplay, notices };
}

/**
 * Loop-rate reason card (B2). The token is `loop_rate_reason` exactly as the
 * FC sent it; nothing is inferred from other state (bidir on/off, board,
 * rates). A missing or malformed reason is "unknown". Explanatory text exists
 * only for tokens the firmware documents (bobflight-firmware/docs/LOOP-RATE.md);
 * an unrecognised token is still shown verbatim, with no explanation.
 * `dshot-bidir-polled-listen` is what firmware before B2 (#57) reports; its
 * "forces 1 kHz" text appears only when the FC reports exactly that token.
 */
export const LOOP_RATE_REASON_UNKNOWN = "unknown";
export const LOOP_RATE_REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "setting": "No fallback: the controller runs its boot setting.",
  "overrun-guard": "The firmware's overrun guard stepped the loop down after sustained overruns. It does not step back up until reboot.",
  "board-has-no-8k-gyro-path": "This board has no 8 kHz gyro path, so the firmware runs its 1 kHz profile.",
  "no-high-res-timebase": "The firmware has no high-resolution timebase, so it runs its 1 kHz profile.",
  "gyro-odr-below-8k": "The gyro does not report an 8 kHz output rate, so the firmware runs its 1 kHz profile.",
  "gyro-spi-clock-slow": "The gyro SPI read clock is below 10 MHz, so the firmware runs its 1 kHz profile.",
  "dshot-bidir-polled-listen": "Bidirectional DShot is on and this firmware's polled eRPM listen forces a 1 kHz loop.",
  "dshot-bidir-reply-window": "Bidirectional DShot is on: the eRPM reply does not fit an 8 kHz loop period, so the firmware lowers the loop below 8 kHz; the applied rate is the Loop target above.",
  "dshot-bidir-capture-failed": "Bidirectional DShot eRPM capture kept failing, so the firmware fell back to its 1 kHz profile. Check the per-motor telemetry on the Motors page; turning bidir off and on again, or rebooting, retries.",
});
export interface LoopRateReasonView {
  /** `loop_rate_reason` as sent, or "unknown". */
  token: string;
  /** Documented meaning of the token; null for unknown/unrecognised tokens. */
  explanation: string | null;
  /** true only when the FC reported a token other than "setting". */
  fallback: boolean;
}
export function loopRateReasonView(report: LoopRateReport | null): LoopRateReasonView {
  const token = report?.reason ?? null;
  if (token === null) return { token: LOOP_RATE_REASON_UNKNOWN, explanation: null, fallback: false };
  const explanation = Object.prototype.hasOwnProperty.call(LOOP_RATE_REASON_TEXT, token) ? LOOP_RATE_REASON_TEXT[token] : null;
  return { token, explanation, fallback: token !== "setting" };
}
