/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FW-shaped fixture replies for scoped defaults (`defaults pid|rates|filters`),
 * built from the frozen reply shape in defaults-scoped.ts. Values are printed
 * like the FW's `get` (`%.6g`). The error lines are the exact FW strings
 * (bobflight-firmware/src/drivers/defaults_cli.h, blackbox_cli.h); the
 * protocol test checks these replies byte-for-byte against the real host
 * firmware binary where the host sim can produce them.
 */
import { DEFAULTS_GROUP_KEYS, type DefaultsGroup } from "./defaults-scoped";
import { DEFAULT_SETTING_VALUES, formatFwFloat, type SettingsKey } from "./settings";

/** How the mock FC answers a scoped defaults command. */
export type DefaultsMockScenario =
  | "ok"
  | "armed" | "bench_active" | "calibration_active" | "unknown_group" | "group_required"
  /** A code this client does not know yet (must still be shown verbatim). */
  | "future_error"
  /** FW refusal while Blackbox records (blackbox_cli_filter). */
  | "blackbox_refused"
  | "missing_end"
  | "count_mismatch"
  | "group_mismatch"
  /** Older FW without scoped defaults. */
  | "unsupported";

export const DEFAULTS_MOCK_SCENARIOS: readonly DefaultsMockScenario[] = [
  "ok", "armed", "bench_active", "calibration_active", "unknown_group", "group_required",
  "future_error", "blackbox_refused", "missing_end", "count_mismatch", "group_mismatch", "unsupported",
];

/** Exact FW refusal lines (plus one invented future code). The UI shows whichever line arrives verbatim. */
export const DEFAULTS_MOCK_ERROR_LINES: Readonly<Record<string, string>> = {
  armed: "defaults_error: armed",
  bench_active: "defaults_error: bench_active",
  calibration_active: "defaults_error: calibration_active",
  unknown_group: "defaults_error: unknown_group",
  group_required: "defaults_error: group_required pid|rates|filters",
  /** Not a FW line: a code this client does not know yet. */
  future_error: "defaults_error: storage_locked_v2 (future FW reason, shown verbatim)",
  blackbox_refused: "command refused: stop Blackbox recording and wait for done before configuration, calibration, motor tests, reboot or bootloader entry",
};

export function defaultsKeyLines(group: DefaultsGroup, values: Partial<Record<SettingsKey, number>> = DEFAULT_SETTING_VALUES): string[] {
  return DEFAULTS_GROUP_KEYS[group].map((k) => `defaults_key: ${k}=${formatFwFloat(values[k] ?? DEFAULT_SETTING_VALUES[k])}`);
}

/** Reply text (CRLF) for `defaults <group>` under a scenario. */
export function mockDefaultsReply(group: DefaultsGroup, scenario: DefaultsMockScenario = "ok"): string {
  const crlf = (ls: string[]) => ls.map((l) => `${l}\r\n`).join("");
  const keys = defaultsKeyLines(group);
  switch (scenario) {
    case "ok": return crlf([`defaults_group: ${group}`, ...keys, `defaults_end: ${group} ${keys.length}`]);
    case "missing_end": return crlf([`defaults_group: ${group}`, ...keys]);
    case "count_mismatch": return crlf([`defaults_group: ${group}`, ...keys.slice(0, -1), `defaults_end: ${group} ${keys.length}`]);
    case "group_mismatch": { const other: DefaultsGroup = group === "pid" ? "rates" : "pid"; const k = defaultsKeyLines(other); return crlf([`defaults_group: ${other}`, ...k, `defaults_end: ${other} ${k.length}`]); }
    case "unsupported": return "unknown — try help\r\n";
    default: return crlf([DEFAULTS_MOCK_ERROR_LINES[scenario]]);
  }
}

/** Reply to bare `defaults` on FW with scoped defaults. */
export const MOCK_BARE_DEFAULTS_REPLY = `${DEFAULTS_MOCK_ERROR_LINES.group_required}\r\n`;
