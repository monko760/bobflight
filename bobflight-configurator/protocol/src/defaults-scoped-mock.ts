/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * FW-shaped fixture replies for scoped defaults (`defaults pid|rates|filters`),
 * built from the frozen reply shape in defaults-scoped.ts. Values are printed
 * like the FW's `get` (`%.6g`). Until the FW branch lands these are fixtures,
 * not host-sim output.
 */
import { DEFAULTS_GROUP_KEYS, type DefaultsGroup } from "./defaults-scoped";
import { DEFAULT_SETTING_VALUES, formatFwFloat, type SettingsKey } from "./settings";

/** How the mock FC answers a scoped defaults command. */
export type DefaultsMockScenario =
  | "ok"
  | "armed" | "bench_active" | "calibration_active" | "unknown_group" | "group_required"
  /** A code this client does not know yet (must still be shown verbatim). */
  | "future_error"
  | "missing_end"
  | "count_mismatch"
  | "group_mismatch"
  /** Older FW without scoped defaults. */
  | "unsupported";

export const DEFAULTS_MOCK_SCENARIOS: readonly DefaultsMockScenario[] = [
  "ok", "armed", "bench_active", "calibration_active", "unknown_group", "group_required",
  "future_error", "missing_end", "count_mismatch", "group_mismatch", "unsupported",
];

/** Error lines used by the mocks. The FW freeze fixes the code token; any trailing text is shown verbatim, whatever it says. */
export const DEFAULTS_MOCK_ERROR_LINES: Readonly<Record<string, string>> = {
  armed: "defaults_error: armed (disarm first)",
  bench_active: "defaults_error: bench_active (stop motor tests first)",
  calibration_active: "defaults_error: calibration_active (finish or cancel calibration)",
  unknown_group: "defaults_error: unknown_group (use pid, rates or filters)",
  group_required: "defaults_error: group_required (use defaults pid|rates|filters)",
  future_error: "defaults_error: storage_locked_v2 (future FW reason, shown verbatim)",
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
