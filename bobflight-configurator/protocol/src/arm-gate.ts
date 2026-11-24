/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * N2: the firmware CLI `arm` reply. Since N2 the flight controller never arms
 * from USB: `arm` runs the same gate as the radio ARM switch and replies
 * `arm refused: <token>` with the first blocking check (tasks.c
 * arm_cli_refusal). Only a fresh radio ARM switch edge (off, then on) arms.
 * Names frozen by the Config Lead (#111 review at 267e95a).
 *
 * Capability: firmware before N2 really arms on `arm`, so the Configurator
 * sends `arm` only when `status` carries exactly one `arm_cli: check` line
 * (N2+ firmware, cli.c cmd_status, right after `arm:`). Absent, duplicated or
 * any other value: Arm check stays disabled and `arm` is never sent.
 *
 * Firmware before N2 replied `armed` or `arm refused (gyro unhealthy or
 * failsafe)`; those are recognised as legacy replies, never rewritten.
 */
export const ARM_REFUSED_PREFIX = "arm refused: ";
export const ARM_LEGACY_REFUSED = "arm refused (gyro unhealthy or failsafe)";

/** `status` key and the only value that means "CLI `arm` is check-only". */
export const ARM_CLI_STATUS_KEY = "arm_cli";
export const ARM_CLI_CHECK = "check";
/** Shown (and Arm check disabled) when `status` has no `arm_cli: check`. */
export const ARM_CLI_OLDER_FIRMWARE_TEXT =
  "Older firmware: the CLI arm command can arm this board. Update firmware to use Arm check.";

/**
 * Strict capability read from a parsed `status`: true only for the exact value
 * `check` (parse-status keeps arm_cli undefined when the line is absent or
 * repeated). null status (not read yet) is false: never send `arm` blind.
 */
export function armCliIsCheckOnly(status: { arm_cli?: string } | null | undefined): boolean {
  return !!status && status.arm_cli === ARM_CLI_CHECK;
}

/** Mock FC firmware generation for `arm`: N2+ ("check") or pre-N2 ("old-fc"). */
export const ARM_CLI_MOCK_SCENARIOS = ["check", "old-fc"] as const;
export type ArmCliMockScenario = (typeof ARM_CLI_MOCK_SCENARIOS)[number];

/** Every token the firmware can print, in the firmware's check order. */
export const ARM_REFUSAL_TOKENS = [
  "already-armed",
  "motors-active",
  "calibration-running",
  "bench-build",
  "no-motor-output",
  "receiver-stale",
  "gravity-not-ready",
  "gyro-not-ready",
  "gyro-unhealthy",
  "failsafe",
  "throttle-not-low",
  "dshot-unhealthy",
  "arm-switch-unavailable",
  "arm-switch-on",
  "gyro-not-calibrated",
  "attitude-not-ready",
  "tilted",
  "arm-switch-required",
] as const;
export type ArmRefusalToken = (typeof ARM_REFUSAL_TOKENS)[number];

/** Plain-language explanation shown next to the verbatim reply. */
export const ARM_REFUSAL_TEXT: Record<ArmRefusalToken, string> = {
  "already-armed": "Already armed (by the radio ARM switch). Nothing changed.",
  "motors-active": "A bench motor test is running. Stop it first.",
  "calibration-running": "Sensor calibration is running. Wait for it to finish.",
  "bench-build": "This is a bench build: it can never arm.",
  "no-motor-output": "This build has no motor output: it can never arm.",
  "receiver-stale": "No fresh receiver frames.",
  "gravity-not-ready": "The accelerometer is not qualified for a leveled mode (Angle/Horizon).",
  "gyro-not-ready": "The gyro is not ready.",
  "gyro-unhealthy": "The gyro is unhealthy (status gyro_ok: no).",
  failsafe: "Failsafe is active (receiver lost or not seen since boot).",
  "throttle-not-low": "Throttle is not low.",
  "dshot-unhealthy": "Motor output (DShot) is unhealthy.",
  "arm-switch-unavailable": "The ARM switch range is disabled or has no fresh receiver value.",
  "arm-switch-on": "The ARM switch is already on. Switch it off, then on, to arm.",
  "gyro-not-calibrated": "The gyro is not calibrated.",
  "attitude-not-ready": "The attitude estimate is not ready yet.",
  tilted: "The craft is tilted more than 20 degrees. Level it (Acro has no tilt check).",
  "arm-switch-required": "All checks pass. Arm with the radio ARM switch (off, then on); USB never arms.",
};

export type ArmReplyKind = "refused" | "legacy-armed" | "legacy-refused" | "unknown";
export interface ArmReply {
  kind: ArmReplyKind;
  /** The first reply line exactly as the firmware sent it ("" if none). */
  line: string;
  /** Token after `arm refused: ` (verbatim, may be unknown), else null. */
  token: string | null;
  /** Explanation for a known token or legacy reply; "" for unknown tokens. */
  explanation: string;
}

export function isArmRefusalToken(t: string): t is ArmRefusalToken {
  return (ARM_REFUSAL_TOKENS as readonly string[]).includes(t);
}

/** Classify an `arm` reply without rewriting it. */
export function parseArmReply(raw: string): ArmReply {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  if (line.startsWith(ARM_REFUSED_PREFIX)) {
    const token = line.slice(ARM_REFUSED_PREFIX.length);
    return { kind: "refused", line, token, explanation: isArmRefusalToken(token) ? ARM_REFUSAL_TEXT[token] : "" };
  }
  if (line === "armed") {
    return { kind: "legacy-armed", line, token: null, explanation: "Firmware before N2: USB arm accepted. Update the firmware." };
  }
  if (line === ARM_LEGACY_REFUSED) {
    return { kind: "legacy-refused", line, token: null, explanation: "Firmware before N2: gyro unhealthy or failsafe." };
  }
  return { kind: "unknown", line, token: null, explanation: "" };
}

/** Mock FC state that the shared gate reads (no radio is simulated beyond the ARM switch). */
export interface MockArmGateState {
  armed: boolean;
  benchActive?: boolean;
  gyroOk: boolean;
  failsafeActive: boolean;
  armSwitchOn: boolean;
  /**
   * MCU builds only: no fresh receiver frame (arming.c `receiver-stale`,
   * checked before gyro and failsafe). Default false models the host build.
   * A USB bench board with no receiver has this AND `failsafe: ACTIVE`.
   */
  receiverStale?: boolean;
}

/**
 * The token a mock FC prints for `arm`, in the firmware order for the subset
 * of checks the mocks model. Like the firmware, never arms.
 */
export function mockArmRefusal(s: MockArmGateState): ArmRefusalToken {
  if (s.armed) return "already-armed";
  if (s.benchActive) return "motors-active";
  if (s.receiverStale) return "receiver-stale";
  if (!s.gyroOk) return "gyro-unhealthy";
  if (s.failsafeActive) return "failsafe";
  if (s.armSwitchOn) return "arm-switch-on";
  return "arm-switch-required";
}

/**
 * Pre-N2 firmware `arm` (the "old-fc" mock), modelled honestly: it really
 * arms when gyro and failsafe pass; with the ARM switch off the next PID
 * cycle disarms again, with it on the arm sticks (the N2 bypass). This is
 * why the Configurator must never send `arm` to such a board.
 */
export function mockLegacyArm(s: MockArmGateState): { reply: string; armed: boolean } {
  if (s.receiverStale || !s.gyroOk || s.failsafeActive) return { reply: ARM_LEGACY_REFUSED, armed: s.armed };
  return { reply: "armed", armed: s.armed || s.armSwitchOn };
}

/**
 * Mock radio ARM switch, the only way a mock FC arms (as on the firmware):
 * an off-to-on edge arms only when the gate passes; switching off disarms.
 * Returns the new armed state.
 */
export function mockArmSwitchEdge(s: MockArmGateState, on: boolean): boolean {
  const wasOn = s.armSwitchOn;
  if (!on) return false;
  if (wasOn || s.armed) return s.armed;
  return !s.benchActive && !s.receiverStale && s.gyroOk && !s.failsafeActive;
}
