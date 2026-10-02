/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Gyro sanity keys in the CLI `status` reply (FW
 * bobflight-firmware/src/drivers/gyro.c gyro_status_lines, doc
 * bobflight-firmware/docs/GYRO-SANITY.md):
 *
 *   gyro_health: ok|stuck|whoami-mismatch|config-lost
 *   gyro_sat_count: <unsigned decimal, samples at a full-scale rail since boot>
 *
 * Display rules (Configurator review bar):
 * - The health token is shown exactly as sent, including tokens this
 *   Configurator does not know yet (a newer firmware may add one).
 * - gyro_sat_count is shown exactly as sent when it is an unsigned decimal
 *   (any length: the firmware counter is 64-bit). It never goes through
 *   Number() or BigInt arithmetic, so a value above 2^32 or 2^53 is not
 *   rounded. Anything else is unknown.
 * - A missing key, an empty value, or a key sent twice shows "unknown".
 * - Nothing here gates arming: the firmware already prints `gyro_ok: no`
 *   whenever gyro_health is not ok, and the existing Arm gate reads gyro_ok.
 */
export const GYRO_HEALTH_KEYS = ["gyro_health", "gyro_sat_count"] as const;
export type GyroHealthKey = (typeof GYRO_HEALTH_KEYS)[number];
export const GYRO_HEALTH_UNKNOWN = "unknown";
/** Tokens the current firmware prints (for docs and mocks only; display never filters on this). */
export const GYRO_HEALTH_TOKENS = ["ok", "stuck", "whoami-mismatch", "config-lost"] as const;
const UNSIGNED_DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export interface GyroHealthView {
  gyro_health: string;
  gyro_sat_count: string;
  /** Neither key present in a reply: firmware predates the gyro sanity contract. */
  olderFirmware: boolean;
}

/** Parse the two gyro sanity keys from a raw `status` reply; null reply = no current reading. */
export function gyroHealthView(raw: string | null): GyroHealthView {
  if (raw === null) return { gyro_health: GYRO_HEALTH_UNKNOWN, gyro_sat_count: GYRO_HEALTH_UNKNOWN, olderFirmware: false };
  const fields = new Map<string, string>();
  const duplicated = new Set<string>();
  for (const rawLine of String(raw).split(/\r?\n/)) {
    const m = /^(gyro_[a-z_]+):(.*)$/.exec(rawLine.trim());
    if (!m || !(GYRO_HEALTH_KEYS as readonly string[]).includes(m[1])) continue;
    if (fields.has(m[1])) duplicated.add(m[1]);
    fields.set(m[1], m[2].trim());
  }
  const value = (key: GyroHealthKey): string | undefined =>
    duplicated.has(key) ? undefined : fields.get(key);
  const health = value("gyro_health");
  const sat = value("gyro_sat_count");
  return {
    gyro_health: health === undefined || health === "" ? GYRO_HEALTH_UNKNOWN : health,
    gyro_sat_count: sat !== undefined && UNSIGNED_DECIMAL.test(sat) ? sat : GYRO_HEALTH_UNKNOWN,
    olderFirmware: fields.size === 0,
  };
}

/**
 * Mock scenarios for the `status` gyro sanity lines. "missing" (default) is an
 * older FC without the keys. Every non-ok health scenario (including the
 * unknown future token) also forces `gyro_ok: no`, as the firmware does.
 */
export const GYRO_HEALTH_MOCK_SCENARIOS = [
  "missing", "ok", "stuck", "whoami-mismatch", "config-lost", "unknown-token", "sat-big",
] as const;
export type GyroHealthMockScenario = (typeof GYRO_HEALTH_MOCK_SCENARIOS)[number];
/** Saturation count above 2^32 and 2^53 (Number() would print 18446744073709552000). */
export const GYRO_HEALTH_MOCK_BIG_SAT = "18446744073709551615";
/** A token the current firmware never prints, standing in for a future one. */
export const GYRO_HEALTH_MOCK_FUTURE_TOKEN = "bias-drift";

export function mockGyroHealthLines(scenario: GyroHealthMockScenario = "missing"): string[] {
  switch (scenario) {
    case "missing": return [];
    case "ok": return ["gyro_health: ok", "gyro_sat_count: 0"];
    case "stuck": return ["gyro_health: stuck", "gyro_sat_count: 3"];
    case "whoami-mismatch": return ["gyro_health: whoami-mismatch", "gyro_sat_count: 0"];
    case "config-lost": return ["gyro_health: config-lost", "gyro_sat_count: 12"];
    case "unknown-token": return [`gyro_health: ${GYRO_HEALTH_MOCK_FUTURE_TOKEN}`, "gyro_sat_count: 7"];
    case "sat-big": return ["gyro_health: ok", `gyro_sat_count: ${GYRO_HEALTH_MOCK_BIG_SAT}`];
  }
}

/** True when the scenario's health is not ok, so the mock prints gyro_ok: no and refuses arm. */
export function mockGyroHealthForcesUnhealthy(scenario: GyroHealthMockScenario): boolean {
  return scenario !== "missing" && scenario !== "ok" && scenario !== "sat-big";
}
