/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
import { gyroHealthView, GYRO_HEALTH_UNKNOWN } from "../protocol";

/**
 * Setup status cards for the firmware gyro sanity keys (`gyro_health`,
 * `gyro_sat_count`), rendered next to the gyro_ok / gyro_bind cards.
 *
 * `raw` is the latest `status` reply from the Setup 1 s poll (null = no
 * current reading, e.g. disconnected or the poll was dropped as stale). Both
 * values are shown exactly as the firmware sent them; missing or malformed
 * shows "unknown". Read-only: nothing here gates arming or any StoragePanel.
 */
export function GyroHealthCards({ raw }: { raw: string | null }) {
  const v = gyroHealthView(raw);
  const warn = v.gyro_health !== "ok" && v.gyro_health !== GYRO_HEALTH_UNKNOWN;
  return (
    <>
      <div className={`status-card${warn ? " status-card-warn" : ""}`}>
        <div className="k">gyro_health</div>
        <div className="v" data-gyro-health="gyro_health">{v.gyro_health}</div>
      </div>
      <div className="status-card">
        <div className="k">gyro_sat_count</div>
        <div className="v" data-gyro-health="gyro_sat_count">{v.gyro_sat_count}</div>
      </div>
    </>
  );
}

/** One-line explanation shown under the Setup status grid. */
export function GyroHealthNote({ raw }: { raw: string | null }) {
  const v = gyroHealthView(raw);
  return (
    <p className="muted" data-gyro-health-note="">
      gyro_health and gyro_sat_count come from the live 1 s <code>status</code> poll.
      Any gyro_health other than ok is latched until reboot and the firmware then
      reports gyro_ok no, so arming stays blocked. Stuck detection runs only
      while armed. gyro_sat_count counts samples at the sensor&apos;s full-scale
      limit since boot and never disarms.
      {v.olderFirmware ? " This firmware does not report gyro_health or gyro_sat_count." : ""}
    </p>
  );
}
