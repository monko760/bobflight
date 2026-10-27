/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Scoped defaults (D1): `defaults pid|rates|filters`. Frozen FW reply shape
 * (FW Lead freeze, 2026-10-26), CRLF lines:
 *
 *   defaults_group: <group>
 *   defaults_key: <key>=<value>        (one per key the FW reset)
 *   defaults_end: <group> <count>
 *
 * or exactly one error line (no group/end lines):
 *
 *   defaults_error: armed|bench_active|calibration_active|unknown_group|group_required ...
 *
 * Bare `defaults` is answered with `defaults_error: group_required pid|rates|filters`.
 * While Blackbox records (or an SD read runs) the FW refuses every
 * configuration command earlier, with one `command refused: ...` line; it
 * changes nothing and is also shown verbatim.
 * Nothing is saved: the FC's storage goes dirty until the user presses Save.
 *
 * The parser never assumes success. A missing `defaults_group`/`defaults_end`
 * line, a group that differs from the one requested, a count that differs from
 * the number of `defaults_key` lines, a malformed or duplicated key line, or
 * any other line gives `kind: "unknown"`: the caller must re-read the values.
 * Error lines are matched by the `defaults_error:` prefix and kept verbatim,
 * including codes this client does not know yet.
 */

import type { SettingsKey } from "./settings";

export const DEFAULTS_GROUPS = ["pid", "rates", "filters"] as const;
export type DefaultsGroup = (typeof DEFAULTS_GROUPS)[number];

export function isDefaultsGroup(g: string): g is DefaultsGroup {
  return (DEFAULTS_GROUPS as readonly string[]).includes(g);
}

/** The exact CLI line for one group. */
export type DefaultsCliCommand = `defaults ${DefaultsGroup}`;
export const DEFAULTS_CLI_COMMANDS: readonly DefaultsCliCommand[] = ["defaults pid", "defaults rates", "defaults filters"];
export function isDefaultsCliCommand(cmd: string): cmd is DefaultsCliCommand {
  return (DEFAULTS_CLI_COMMANDS as readonly string[]).includes(cmd);
}

/**
 * Keys each group resets, using the FW CLI key names on main (config.c / cli.c).
 * Used for the confirm dialog; the result itself is whatever `defaults_key`
 * lines the FW sends (shown verbatim).
 */
export const DEFAULTS_GROUP_KEYS: Readonly<Record<DefaultsGroup, readonly SettingsKey[]>> = {
  pid: [
    "pid_roll_p", "pid_roll_i", "pid_roll_d",
    "pid_pitch_p", "pid_pitch_i", "pid_pitch_d",
    "pid_yaw_p", "pid_yaw_i", "pid_yaw_d",
    "min_throttle", "airmode",
  ],
  rates: [
    "rate_center_roll", "rate_center_pitch", "rate_center_yaw",
    "rate_max_roll", "rate_max_pitch", "rate_max_yaw",
    "rate_expo_roll", "rate_expo_pitch", "rate_expo_yaw",
  ],
  filters: [
    "gyro_lpf_hz", "dterm_lpf_hz",
    "gyro_notch1_hz", "gyro_notch1_cutoff_hz", "gyro_notch2_hz", "gyro_notch2_cutoff_hz",
    "rpm_filter_harmonics", "rpm_filter_min_hz", "rpm_filter_q_x100",
  ],
};

/** Error codes in the frozen contract. Unknown future codes are still shown verbatim. */
export const DEFAULTS_ERROR_CODES = ["armed", "bench_active", "calibration_active", "unknown_group", "group_required"] as const;
export type DefaultsErrorCode = (typeof DEFAULTS_ERROR_CODES)[number];

export const DEFAULTS_ERROR_PREFIX = "defaults_error:";
/** FW blackbox_cli_filter refusal (whole reply is this one line while Blackbox records). */
export const FC_COMMAND_REFUSED_PREFIX = "command refused:";
/** Shown (never replaced) whenever the result cannot be proven. */
export const DEFAULTS_RESULT_UNKNOWN = "Defaults result unknown, re-read";

export interface DefaultsKeyLine { key: string; value: string; line: string }

export type DefaultsGroupResult =
  | { kind: "ok"; group: DefaultsGroup; count: number; keys: DefaultsKeyLine[]; keyLines: string[]; raw: string }
  | { kind: "error"; line: string; code: string; known: boolean; raw: string }
  /** The FC does not know the command at all (older FW): nothing was changed. */
  | { kind: "unsupported"; line: string; raw: string }
  | { kind: "unknown"; reason: string; keyLines: string[]; raw: string };

const GROUP_RE = /^defaults_group: (\S+)$/;
const KEY_RE = /^defaults_key: ([A-Za-z0-9_]+)=(\S+)$/;
const END_RE = /^defaults_end: (\S+) (\S+)$/;
const UNKNOWN_CMD_RE = /^unknown(?: — try help| command)?$/;

function lines(raw: string): string[] {
  return raw.split(/\r\n|\n|\r/).map((l) => l.trim()).filter((l) => l.length > 0);
}

/** Parse the reply to `defaults <requested>`. Never reports success unless the frame is complete and consistent. */
export function parseDefaultsGroupReply(raw: string, requested: DefaultsGroup): DefaultsGroupResult {
  const all = lines(raw);
  const keyLines = all.filter((l) => l.startsWith("defaults_key:"));
  const unknown = (reason: string): DefaultsGroupResult => ({ kind: "unknown", reason, keyLines, raw });

  const err = all.find((l) => l.startsWith(DEFAULTS_ERROR_PREFIX));
  if (err !== undefined) {
    const code = err.slice(DEFAULTS_ERROR_PREFIX.length).trim().split(/\s+/)[0] ?? "";
    return { kind: "error", line: err, code, known: (DEFAULTS_ERROR_CODES as readonly string[]).includes(code), raw };
  }
  if (all.length === 1 && all[0].startsWith(FC_COMMAND_REFUSED_PREFIX)) return { kind: "error", line: all[0], code: "command_refused", known: true, raw };
  if (all.length === 1 && UNKNOWN_CMD_RE.test(all[0])) return { kind: "unsupported", line: all[0], raw };
  if (all.length === 0) return unknown("empty reply");

  const g = GROUP_RE.exec(all[0]);
  if (!g) return unknown(`first line is not defaults_group: ${JSON.stringify(all[0])}`);
  if (g[1] !== requested) return unknown(`group mismatch: requested ${requested}, FC answered ${g[1]}`);

  const last = all[all.length - 1];
  const e = END_RE.exec(last);
  if (!e) return unknown("defaults_end line missing");
  if (e[1] !== requested) return unknown(`group mismatch: requested ${requested}, defaults_end says ${e[1]}`);
  if (!/^(?:0|[1-9][0-9]{0,4})$/.test(e[2])) return unknown(`defaults_end count is not a number: ${JSON.stringify(e[2])}`);
  const count = Number(e[2]);

  const keys: DefaultsKeyLine[] = [];
  const seen = new Set<string>();
  for (const l of all.slice(1, -1)) {
    const k = KEY_RE.exec(l);
    if (!k) return unknown(`unexpected line: ${JSON.stringify(l)}`);
    if (seen.has(k[1])) return unknown(`duplicate key: ${k[1]}`);
    seen.add(k[1]);
    keys.push({ key: k[1], value: k[2], line: l });
  }
  if (keys.length !== count) return unknown(`count mismatch: defaults_end says ${count}, FC sent ${keys.length} defaults_key lines`);
  // N1: success needs exactly this group's key set (FW table order), nothing more or less.
  const want = DEFAULTS_GROUP_KEYS[requested];
  if (count !== want.length) return unknown(`count mismatch: ${requested} has ${want.length} keys, defaults_end says ${count}`);
  const foreign = keys.find((k) => !(want as readonly string[]).includes(k.key));
  if (foreign) return unknown(`key not in ${requested}: ${foreign.key}`);
  const missing = want.find((k) => !seen.has(k));
  if (missing) return unknown(`key missing from ${requested}: ${missing}`);
  return { kind: "ok", group: requested, count, keys, keyLines: keys.map((k) => k.line), raw };
}

/** True when a complete line ends the reply to `defaults <g>` (end or error line, or an unknown-command line). */
export function isDefaultsReplyEnd(line: string): boolean {
  const l = line.trim();
  return END_RE.test(l) || l.startsWith(DEFAULTS_ERROR_PREFIX) || l.startsWith(FC_COMMAND_REFUSED_PREFIX) || UNKNOWN_CMD_RE.test(l);
}

/**
 * Settings the FW does NOT touch for any scoped group. Listed in the confirm
 * dialog so nobody expects `defaults pid` to reset hardware setup.
 */
export const DEFAULTS_NOT_TOUCHED = [
  "board alignment (align_board_*)",
  "motor direction and motor poles",
  "loop rate (loop_rate_hz)",
  "accelerometer and gyro calibration",
  "receiver, ports, modes and power settings",
  "the other tabs' settings",
] as const;
