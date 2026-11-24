/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
import type { ParsedModes } from "../protocol";

/* N1 leveled-mode rate fallback, from the `modes` report (names frozen with Config Lead; any new reason or state value is a contract change). */
export const LEVEL_FALLBACK_LABELS = {
  title: "Leveled-mode rate fallback",
  notReported: "Not reported by this firmware.",
  notReportedMock: "Not reported — demo, no attitude estimator or hardware.",
  inactive: "Inactive at the last controller pass (it engages only while armed).",
  activeAttitude: "ACTIVE — attitude unavailable: the manually selected Angle or Level (Horizon) mode and failsafe HOLD/LAND fly rate (Acro) control on the gyro until the estimate recovers. Sticks command rotation rates; centered sticks hold the current angle without self-leveling. The controller does not disarm for this in the air.",
  activeGravity: "ACTIVE — failsafe HOLD/LAND without qualified gravity: holding zero rotation rates at the failsafe throttle instead of leveling. The controller does not disarm for this in the air.",
} as const;
const ATTITUDE_STATE_LABELS: Record<string, string> = {
  valid: "valid",
  uninitialized: "not initialized (no gravity reference yet)",
  "accel-invalid": "accelerometer data invalid",
  "gravity-timeout": "no gravity reference for too long",
  recovering: "recovering (gravity reference back, converging)",
};

export function levelFallbackView(s: Pick<ParsedModes, "levelFallback" | "source"> | null): { state: "unreported" | "inactive" | "active"; text: string; attitude: string; count: string } {
  const f = s?.levelFallback;
  if (!f) return { state: "unreported", text: s?.source === "mock" ? LEVEL_FALLBACK_LABELS.notReportedMock : LEVEL_FALLBACK_LABELS.notReported, attitude: "not reported", count: "not reported" };
  const text = !f.active ? LEVEL_FALLBACK_LABELS.inactive : f.reason === "failsafe-gravity-unqualified" ? LEVEL_FALLBACK_LABELS.activeGravity : LEVEL_FALLBACK_LABELS.activeAttitude;
  return { state: f.active ? "active" : "inactive", text, attitude: ATTITUDE_STATE_LABELS[f.attitudeState] ?? f.attitudeState, count: String(f.count) };
}

/** Read-only snapshot; nothing here feeds a setter or the arm gate. */
export function LevelFallbackReadout({ snapshot }: { snapshot: Pick<ParsedModes, "levelFallback" | "source"> | null }) {
  const v = levelFallbackView(snapshot);
  return <div data-level-fallback={v.state}>
    <p role={v.state === "active" ? "alert" : undefined} className={v.state === "active" ? "banner-warn" : undefined}>
      {LEVEL_FALLBACK_LABELS.title}: <strong data-level-fallback-text>{v.text}</strong>
    </p>
    <p>Attitude estimate (attitude_state): <code data-level-fallback-attitude>{v.attitude}</code>. Fallback engagements while armed since boot (level_fallback_count): <code data-level-fallback-count>{v.count}</code>. Snapshot only, not a continuously updated indicator.</p>
  </div>;
}
