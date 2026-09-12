# Sensor calibration and bounded live telemetry

Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0

This is bench functionality, not flight qualification. Remove propellers and
use USB-only power for sensor calibration. Flight arming remains disabled in
the normal bench build. The 35% motor command cap and one-second motor timeout
are unchanged. Manual sensor calibration and motor tests exclude one another;
Stop remains available while calibration is active.

## Support and storage

The calibrated sample path currently supports the MPU6K-class path used by the
Kakute F7 HDV / MPU6000. Other probe paths are not newly qualified and report
calibration unsupported/unverified. The MPU initialization now reads back
GYRO_CONFIG=0x18 (±2000 dps), ACCEL_CONFIG=0x10 (±8 g), power/clock selection,
sample-rate divider and filter configuration. Mismatches fail initialization.
MPU INT_STATUS.DATA_RDY is checked before a new sample is counted. Repeated
reads without new hardware data do not advance the telemetry sample sequence
or calibration. A held sample can serve the cascade for at most 20 ms; the
original acquisition timestamp remains unchanged.

**All coefficients are RAM-only and disappear on reboot/power loss.** The MCU
flash HAL remains a stub. Neither the calibration UI nor its Apply button
claims to save to flash. No new flash writes or persistent config schema are
introduced. Existing applied coefficients survive cancellation or failed
recalibration within the same boot.

## Workflow

1. Open Sensors, confirm props removed and the board stationary. Verify fresh
   healthy readings and configuration diagnostics. Gyro bias normally calibrates
   at startup; the button starts a new explicit stationary window.
2. For acceleration, start a six-face session. For each signed raw axis (+X,
   -X, +Y, -Y, +Z, -Z), orient the selected axis physically vertical and check that its raw reading
   has the selected sign and dominates the other axes, then capture without
   moving it. Unknown offsets can move the readings away from exactly ±1 g/zero. Raw means uncalibrated values after the existing board-axis rotation; it
   does not mean a guessed nose/wing/upside-down mounting direction.
3. Only after all six faces pass, Apply installs the diagonal bias/scale
   solution atomically. Verify corrected acceleration near 1 g in multiple
   orientations. Re-run gyro calibration while still if needed. Cancel stops
   either session without wiping previous applied coefficients.

Gyro windows require at least 1000 distinct millisecond samples and at least
1000 elapsed milliseconds. Face windows require 500 samples and 500 ms.
Movement, gaps over 20 ms and invalid pose reset collection. Gyro rates must
be within ±5 dps; standard deviations must be at most 0.2 dps for gyro and
0.02 g for acceleration. Collection times out after 30 seconds; a six-face
session expires at 5 minutes. These timing/movement guards are unchanged.

### Raw acquisition versus corrected validation

Gyro zero-rate bias is now independent of an already calibrated accelerometer.
A stationary angular-rate window can complete with a raw 0.82 g or 1.2 g norm.
It still requires finite raw samples, a raw accel norm of 0.6–1.5 g (rejects
freefall/rails/grossly implausible input), gyro components within ±5 dps, unchanged
rate/accel variance limits, a full timed window and fresh hardware samples.
Raw accel variance is used rather than variance after a possibly incorrect
calibration. No single gyro window can prove the absence of slow constant
rotation or constant acceleration: physically secure the stationary board.

This does **not** mark acceleration calibrated or qualify flight. The MCU
pre-arm path now explicitly requires `gyro_flight_ready()`: completed gyro
bias, an accepted accelerometer solution, healthy verified recent IMU data,
and corrected gravity within 0.9–1.1 g. The bench build still unconditionally
refuses arming. Existing RX/throttle/failsafe guards remain in force. Attitude
preview is only a visual estimate, not a flight-readiness indicator.

Accelerometer staging retains the prior raw envelope: norm 0.6–1.5 g, selected
signed component 0.6–1.4 g, orthogonal components within ±0.4 g. Capture is
not approval of the sensor. Accelerometer solve/Apply limits below are unchanged.

Apply still requires every face. The diagonal solve is
`bias=(positive+negative)/2`, `scale=2/(positive-negative)`, corrected value
`(raw-bias)*scale`. It never normalizes individual samples to unit length.
Validation is joint and atomic:

- Finite coefficients; scale remains 0.9–1.1. Absolute bias is ≤0.3 g per
  axis **and** the full bias vector length must be ≤0.3 g. This is an explicit
  experimental bench budget, not a claim about MPU6000 datasheet tolerance.
- All three opposite-face pair midpoints must agree with the same 3-D bias
  within 0.05 g per component. Changing offsets/inconsistent poses are refused.
- Every corrected face component must remain within 0.1 g of its ideal signed
  pose, and each corrected norm must be within 0.9–1.1 g. This is not a full
  cross-axis/misalignment fit. All checks precede any coefficient write.

An accepted offset vector above 0.1 g produces a large-offset/hardware-check
reason. Such a correction is for diagnosis, not flight qualification; inspect
hardware and check additional stationary orientations/repeatability. Existing
applied coefficients survive failed Apply/cancel. Gyro bias can now be measured
before or after an accelerometer solution; do not start another manual session
without finishing or explicitly cancelling the active one.

Robert reported approximately 0.815 g upright and 1.2 g inverted. These are
magnitudes from approximate observations, not a verified signed calibration
pair. A synthetic +0.8/-1.2 g pair corresponds to a -0.2 g bias with unit
sensitivity and is covered by the new end-to-end capture/solve test. A uniformly
low ±0.82 g signal still fails Apply's unchanged scale bounds: the solver does
not quietly enlarge the scale allowance. A raw stationary 0.82 g reading alone
is neither proof of a defective sensor nor sufficient evidence to apply any
correction. Register configuration, sign, full six-face geometry and physical
repeatability must be checked; this patch does not establish the hardware cause.

## Recovery and numerical Apply diagnostics

The Gyro section now has a dedicated **Cancel gyro calibration** control during
both automatic and manual gyro collection. Cancellation still uses the existing
command and is allowed while connected even if samples are stale or the safety
checkboxes are unchecked (unless another command is pending). It preserves
applied coefficients but discards unfinished faces. No hidden session override,
queued restart or weakened safety gate was added. The disabled start button
is no longer presented as a separate "Blocked" failure during gyro collection.
Manual request errors persist across telemetry polls until another command or
connection/visibility reset; a successful read must not erase an Apply refusal.

`cal_apply_detail` supplies a bounded human-readable report on ordinary sensor
queries. A rejected Apply automatically opens extended diagnostics in the UI.
`calibration` adds optional `cal_diagnostics_version: 1`, all six
`cal_raw_face_0..5` vectors (or `uncaptured`/`unavailable`), candidate availability
and finite candidate bias/scale vectors. These are explicitly staged/candidate
values, not applied coefficients. Existing applied bias/scale fields are unchanged.
Clients without these optional fields continue working and show them unavailable;
new parsers reject incomplete/malformed declared reports. Request framing and
serialization are unchanged. A copy-report button/plain-text fallback avoids
relying on tiny screenshots. Detailed telemetry is larger; actual device FPS
and USB delivery still require physical validation.

Midpoint rejection names the pair, axis, midpoint, candidate bias, signed
difference and 0.05 g threshold. It identifies an inconsistent comparison,
**not which individual capture is incorrect**. Both the reported pair and the
pair used to derive that bias component may contribute. Pose residual/offset/
scale failures also report their relevant numbers. Starting a new session or
recapturing clears the previous candidate/report to avoid mixing generations.
Applied coefficients remain untouched until every existing Apply check passes.

## Protocol and UI freshness

- `sensors`: bounded key:value snapshot ending in `sensors_end: 1`.
- `calibration`: snapshot plus applied coefficients/register diagnostics,
  ending in `calibration_end: 1`.
- `calibrate_gyro`, `calibrate_accel start`, `calibrate_accel <signed-axis>`,
  `calibrate_accel apply`, `calibration_cancel` / `calibrate_accel cancel`.

Mutation requests require disarmed state, stopped motors, a connected USB
session and a supported/config-verified sample no older than 100 ms. Manual
sessions additionally expire after 2 seconds without sensor-page queries,
or on USB loss/unsafe/stale sensor state. Thus hiding/leaving the Sensors page
cannot leave an indefinite calibration lock. Applied values remain intact.

Snapshots carry device `sample_seq`, acquisition `sample_ms`, `sensor_age_ms`,
health, calibration state/progress/face mask, arm/motor state and raw/corrected
values. The configurator validates required fields and exact finite vectors;
missing/invalid safety data is not defaulted to disarmed or zero motion.
Freshness expires without new replies, and a repeated sequence cannot keep
old data looking live. Heading is not measured; the illustration uses valid
roll/pitch only and can become unavailable near the limited-tilt estimator's
pitch singularity. Calibration capture itself does not require attitude-ready.

The Sensors page replaces the previous 400 ms-after-reply status polling with
bounded approximately 20 Hz start-to-start queries. The new explicit end
marker avoids the legacy 40 ms quiet-window wait for these two read commands
only. Incomplete framed replies are rejected and the port is disconnected to
avoid misattributing late bytes to another command. Older firmware receives
an update-required message rather than repeated unsupported queries.

One local transaction is allowed at a time; sensor reads never queue, user
calibration actions wait only for the current read, and generation changes
invalidate unsent actions/old results. Polling pauses while hidden/unmounted
and resumes on visibility. No interpolation invents unmeasured motion. The
page reports received fresh-sample FPS; 20 Hz is a target, not hardware-measured
performance or a guarantee. Higher polling adds cooperative CLI formatting
work; its effect on real hardware must be measured. The clock tree, DShot/DMA
implementation, USB HAL, boot LED policy and hal_micros resolution are not
changed by this feature.

## Validation boundary

Host tests cover engine mathematics, stationary/motion/noise gates, independent gyro completion at
0.82 g and uniform-low-sensitivity accel Apply rejection, nonfinite data, duplicate timestamps, timeouts/wrap, failed/cancelled
staging, register mismatch/data-ready behavior and manual-session expiration.
CLI tests cover exact face argument mapping and armed/motor/USB/health/config/
stale refusal. Configurator tests cover framing, allowlisting, strict parsing,
freshness, workflow gates, transaction serialization and generation invalidation.
Existing motor/DFU/settings suites are retained. Cross-build success and these
models do not prove physical calibration, sensor axes, actual FPS or flight
safety; verify the merged firmware/configurator pair on the props-off bench.

## Focused recovery review and validation

The background architecture review supported separating stationary gyro bias
from accelerometer accuracy, adding an obvious cancel control, and exposing
Apply measurements without widening solver limits. Parent inspection found
that existing attitude preview readiness alone was not a sufficiently strict
pre-arm substitute, so the explicit MCU accelerometer/gravity gate was added
and tested. The reviewer assessed the architecture; this is not an independent
full-patch audit or physical validation.

Fresh validation: 19/19 host tests (including MCU-enabled pre-arm rejection,
real MPU driver with mock SPI at raw ~0.82 g, session cancellation, six-face
Apply, stale IMU and bad corrected-gravity refusal), 10 sensor UI/parser/lane
regression groups, 28 motor UI groups, sensor/motor protocol tests, strict
C11 warnings, ASan/UBSan calibration checks, configurator production build
and Kakute F745 cross-build. Linked bench arming remains disabled. DShot,
timer/DMA, clock, USB, scheduler and bench arming object bytes match 890061b.
All new implementation is original Apache-2.0 code; no dependency, vendored
source or GPL-source import was introduced. No whole-repository license audit
or flight qualification is claimed.
