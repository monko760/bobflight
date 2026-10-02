/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * When the Motors-tab motor_direction selector is locked (#63 Config Lead,
 * R6-R11). Pure, so the Motors page and the tests share it. The FW refuses a
 * set while armed or while a motor test runs; these locks keep the UI from
 * even sending it, and the FW refusal (shown verbatim) stays the backstop.
 * Checked in this order; the first reason is shown on the panel:
 *   1. not connected (useHost connectionStatus and the bench controller)
 *   2. post-flash gate
 *   3. arming state other than exactly `disarmed` (missing/unknown counts as locked;
 *      the FC token is shown verbatim)
 *   4. a motor test the page started is inside its test window
 *   5. a page motor-test request or a stop is in flight (storageBlocked)
 *   6. a StoragePanel save / refresh / export is pending (lifted out via onPending)
 */
export interface MotorDirectionLockInputs {
  connected: boolean;
  postFlashGate: boolean;
  /** `status` arm token as the FC sent it; undefined/null when not (yet) known. */
  arm: string | null | undefined;
  motorTestRunning: boolean;
  storageBlocked: boolean;
  storagePending: boolean;
}
export function motorDirectionLockReason(i: MotorDirectionLockInputs): string | null {
  if (!i.connected) return "Locked: not connected.";
  if (i.postFlashGate) return "Locked after flashing until the controller reconnects and reports its version.";
  if (i.arm !== "disarmed") {
    return i.arm === undefined || i.arm === null || i.arm === ""
      ? "Locked: arming state unknown (the controller must report arm: disarmed)."
      : `Locked: the controller reports arm: ${i.arm} (must be disarmed).`;
  }
  if (i.motorTestRunning) return "Locked while a motor test runs.";
  if (i.storageBlocked) return "Locked while a motor test request or stop is in flight.";
  if (i.storagePending) return "Locked while a controller storage action (save, refresh or export) is pending.";
  return null;
}
