/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Shows the FC's `accel_cal_saved:` storage line verbatim next to Save. A save
 * after a board-alignment change drops the saved accelerometer calibration
 * (FW rule) and the save reply does not say so; this line does.
 */
import { readAccelCalSaved, ACCEL_CAL_SAVED_UNKNOWN } from "../protocol";

export const ACCEL_CAL_NOT_SAVED_NOTE =
  "Accelerometer calibration is not saved on the controller and needs redoing: calibrate the accelerometer on the Setup tab, then Save to controller. (Saving after a board alignment change drops a saved accelerometer calibration.)";

export function AccelCalSavedNote({ raw }: { raw: string }) {
  const r = readAccelCalSaved(raw);
  return (
    <div data-testid="accel-cal-saved">
      <p className="muted">Controller reports: <code data-testid="accel-cal-saved-line">{r.line ?? `accel_cal_saved: ${ACCEL_CAL_SAVED_UNKNOWN}`}</code>{r.line === null && " (line missing from the storage reply)"}</p>
      {r.value === "no" && <p className="banner-warn" role="alert" data-testid="accel-cal-not-saved">{ACCEL_CAL_NOT_SAVED_NOTE}</p>}
    </div>
  );
}
