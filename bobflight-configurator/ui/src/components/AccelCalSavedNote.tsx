/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/**
 * Shows the FC's `accel_cal_saved:` storage line next to Save (StoragePanel,
 * PID, Rates, Filters). A save after a board-alignment change drops the saved
 * accelerometer calibration (FW rule) and the save reply does not say so.
 *
 * Only a byte-exact `accel_cal_saved: yes` / `accel_cal_saved: no` is shown
 * bare. Anything else is "unknown"; an unrecognised line is quoted with
 * JSON.stringify so trailing spaces, tabs, zero-width or look-alike
 * characters cannot pass for a real yes.
 */
import { readAccelCalSaved } from "../protocol";

export const ACCEL_CAL_NOT_SAVED_NOTE =
  "Accel calibration is not saved on the board. If you calibrated after the last alignment change, press Save; otherwise recalibrate on the Setup tab.";

/** The text inside the line element: the exact FC line, or unknown (with the quoted line if one came). */
export function accelCalSavedText(raw: string): string {
  const r = readAccelCalSaved(raw);
  if (r.value !== "unknown") return r.line!;
  if (r.reason === "unrecognised") return `unknown (FC sent: ${JSON.stringify(r.line)})`;
  return "accel_cal_saved: unknown";
}

export function AccelCalSavedNote({ raw }: { raw: string }) {
  const r = readAccelCalSaved(raw);
  return (
    <div data-testid="accel-cal-saved">
      <p className="muted">
        Controller reports: <code data-testid="accel-cal-saved-line">{accelCalSavedText(raw)}</code>
        {r.reason === "missing" && " (line missing from the storage reply)"}
        {r.reason === "repeated" && " (repeated line in the storage reply)"}
      </p>
      {r.value === "no" && <p className="banner-warn" role="alert" data-testid="accel-cal-not-saved">{ACCEL_CAL_NOT_SAVED_NOTE}</p>}
    </div>
  );
}
