/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * N2: the firmware CLI `arm` reply. Since N2 the flight controller never arms
 * from USB: `arm` runs the same gate as the radio ARM switch and replies
 * `arm refused: <token>` with the first blocking check (tasks.c
 * arm_cli_refusal). Only a fresh radio ARM switch edge (off, then on) arms.
 * Token names are pending the Config Lead freeze.
 *
 * Firmware before N2 replied `armed` or `arm refused (gyro unhealthy or
 * failsafe)`; those are recognised as legacy replies, never rewritten.
 */
export const ARM_REFUSED_PREFIX = "arm refused: ";
export const ARM_LEGACY_REFUSED = "arm refused (gyro unhealthy or failsafe)";

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
}

/**
 * The token a mock FC prints for `arm`, in the firmware order for the subset
 * of checks the mocks model. Like the firmware, never arms.
 */
export function mockArmRefusal(s: MockArmGateState): ArmRefusalToken {
  if (s.armed) return "already-armed";
  if (s.benchActive) return "motors-active";
  if (!s.gyroOk) return "gyro-unhealthy";
  if (s.failsafeActive) return "failsafe";
  if (s.armSwitchOn) return "arm-switch-on";
  return "arm-switch-required";
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
  return !s.benchActive && s.gyroOk && !s.failsafeActive;
}
