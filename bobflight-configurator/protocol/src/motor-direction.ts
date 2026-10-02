/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Motor direction (FW CLI setting `motor_direction`, config schema 10, tentative).
 * It tells the mixer which way the props spin. It does NOT change the spin
 * direction in the ESC. Frozen FW contract (bobflight-firmware/src/drivers/motor_direction_cli.h):
 *
 *   get motor_direction            -> "motor_direction=<token>"         older FC: "unknown key"
 *   set motor_direction <token>    -> "ok motor_direction=<token>"
 *                                     "set failed: armed"
 *                                     "set failed: motor test running"
 *                                     "set failed: motor_direction must be props-out or props-in"
 *   mixer                          -> framed report (exactly these lines, in this order):
 *                                     mixer_api: 1 / mixer: quadx / motor_direction: <token> /
 *                                     mixer_yaw_m1..m4: -1|+1 / mixer_end: 1
 *
 * Review bar: tokens and signs are kept exactly as the FC sent them (unknown
 * future tokens included); anything missing, duplicated or malformed is
 * "unknown"; nothing is computed from FC values. Only the two known tokens
 * are ever sent.
 */
export const MOTOR_DIRECTION_KEY = "motor_direction";
export const MOTOR_DIRECTION_OPTIONS = ["props-out", "props-in"] as const;
export type MotorDirectionOption = (typeof MOTOR_DIRECTION_OPTIONS)[number];
/** Exact FW lines (motor_direction_cli.h); the mocks print these and the UI shows them verbatim. */
export const MOTOR_DIRECTION_ARMED_LINE = "set failed: armed";
export const MOTOR_DIRECTION_MOTOR_TEST_LINE = "set failed: motor test running";
export const MOTOR_DIRECTION_INVALID_LINE = "set failed: motor_direction must be props-out or props-in";
export const MOTOR_DIRECTION_UNKNOWN = "unknown";
/** The Configurator copy (also asserted by the render test and the FW doc). */
export const MOTOR_DIRECTION_COPY = "This tells the mixer which way the props spin. It does not change ESC spin direction.";
export const MOTOR_DIRECTION_BENCH_TEST = "props off, Acro, armed above 5% throttle: rotate the frame clockwise (viewed from above) by hand and the clockwise-spinning motors (viewed from above) should speed up";

export type MotorDirectionCliCommand = "get motor_direction" | `set motor_direction ${MotorDirectionOption}` | "mixer";
export const MOTOR_DIRECTION_CLI_COMMANDS: readonly MotorDirectionCliCommand[] = [
  "get motor_direction", "set motor_direction props-out", "set motor_direction props-in", "mixer",
] as const;
export function isMotorDirectionOption(v: unknown): v is MotorDirectionOption {
  return typeof v === "string" && (MOTOR_DIRECTION_OPTIONS as readonly string[]).includes(v);
}
export function isMotorDirectionCliCommand(cmd: string): cmd is MotorDirectionCliCommand {
  return (MOTOR_DIRECTION_CLI_COMMANDS as readonly string[]).includes(cmd);
}
/** Only the two known tokens can become a command; anything else throws (never sent). */
export function motorDirectionSetCommand(v: MotorDirectionOption): MotorDirectionCliCommand {
  if (!isMotorDirectionOption(v)) throw new Error(`unsupported motor_direction: ${String(v)}`);
  return `set ${MOTOR_DIRECTION_KEY} ${v}`;
}

const lines = (raw: string) => String(raw).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
/** A token as the FW prints it (lowercase word with dashes): kept verbatim, known or not. */
const TOKEN = /^[a-z0-9][a-z0-9-]*$/;

/** `get motor_direction`: the FC token verbatim (known or a future one), older FC, or malformed. */
export type MotorDirectionGetResult =
  | { kind: "value"; token: string }
  | { kind: "unsupported" }
  | { kind: "malformed"; raw: string };
export function parseMotorDirectionGetReply(raw: string): MotorDirectionGetResult {
  const ls = lines(raw);
  if (ls.length === 1 && ls[0] === "unknown key") return { kind: "unsupported" };
  const m = ls.length === 1 ? /^motor_direction=(\S+)$/.exec(ls[0]) : null;
  if (m && TOKEN.test(m[1])) return { kind: "value", token: m[1] };
  return { kind: "malformed", raw: String(raw).trim() };
}

/** `set motor_direction <requested>`: accepted only when the FC echoes exactly the requested token.
 * `line` is the FC's reply verbatim; null when the reply had no text at all (that is not an FC
 * refusal: the UI shows it as an error, never in the refusal slot). */
export type MotorDirectionSetResult =
  | { ok: true; token: MotorDirectionOption }
  | { ok: false; unsupported: boolean; line: string | null };
export function parseMotorDirectionSetReply(raw: string, requested: MotorDirectionOption): MotorDirectionSetResult {
  const ls = lines(raw);
  if (ls.length === 1 && ls[0] === `ok motor_direction=${requested}`) return { ok: true, token: requested };
  return { ok: false, unsupported: ls[0] === "unknown key", line: ls.length ? ls.join(" ") : null };
}

/** Framed `mixer` report. Fields absent, duplicated or malformed are null (shown "unknown"). */
export interface MixerReport { mixer: string | null; motorDirection: string | null; yaw: [string | null, string | null, string | null, string | null]; }
export function parseMixerReport(raw: string): MixerReport | null {
  const ls = lines(raw);
  if (ls[0] !== "mixer_api: 1" || ls[ls.length - 1] !== "mixer_end: 1") return null;
  const seen = new Map<string, string>(); const dup = new Set<string>();
  for (const l of ls.slice(1, -1)) {
    const m = /^([a-z0-9_]+): (\S+)$/.exec(l);
    if (!m) continue;
    if (seen.has(m[1])) dup.add(m[1]);
    seen.set(m[1], m[2]);
  }
  const get = (k: string, re: RegExp): string | null => { const v = seen.get(k); return v === undefined || dup.has(k) || !re.test(v) ? null : v; };
  const sign = (m: number) => get(`mixer_yaw_m${m}`, /^[+-]1$/);
  return { mixer: get("mixer", TOKEN), motorDirection: get("motor_direction", TOKEN), yaw: [sign(1), sign(2), sign(3), sign(4)] };
}

export interface MotorDirectionView {
  /** true only for a real `motor_direction=<token>` reply; false: older FC ("unknown key");
   * null: no reading yet, or a malformed reply (shown "unknown"; nothing can be set). */
  supported: boolean | null;
  /** What the FC holds (`get motor_direction`), verbatim; "unknown" when missing/malformed. */
  held: string;
  /** The held token when it is one the UI can select; null for unknown/future tokens. */
  selected: MotorDirectionOption | null;
  /** From the `mixer` report, verbatim or "unknown". */
  mixerDirection: string;
  yaw: [string, string, string, string];
}
export function motorDirectionView(get: MotorDirectionGetResult | null, report: MixerReport | null): MotorDirectionView {
  const U = MOTOR_DIRECTION_UNKNOWN;
  const held = get?.kind === "value" ? get.token : U;
  return {
    supported: get?.kind === "value" ? true : get?.kind === "unsupported" ? false : null,
    held,
    selected: isMotorDirectionOption(held) ? held : null,
    mixerDirection: report?.motorDirection ?? U,
    yaw: [report?.yaw[0] ?? U, report?.yaw[1] ?? U, report?.yaw[2] ?? U, report?.yaw[3] ?? U],
  };
}
