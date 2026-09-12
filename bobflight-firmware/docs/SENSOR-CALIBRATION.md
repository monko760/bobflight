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

Gyro calibration still requires **corrected** gravity within 0.9–1.1 g. Before
an accelerometer solution exists, raw gravity can lie outside that interval
because of an offset. Requiring the same near-1-g norm for raw six-face capture
was a circular prerequisite in PR10, corrected by this update.

Only accelerometer staging uses the broader raw envelope: norm 0.6–1.5 g,
selected signed component 0.6–1.4 g, orthogonal components within ±0.4 g. This
allows modest unknown offsets on all three axes, while excluding wrong signs,
freefall, saturation and grossly wrong poses. Capture is **not** approval of
the sensor, and these are not relaxed flight/gyro-validity gates.

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
applied coefficients survive failed Apply/cancel. If gyro calibration was
blocked initially, explicitly re-run it after a successful accelerometer Apply.

Robert reported approximately 0.815 g upright and 1.2 g inverted. These are
magnitudes from approximate observations, not a verified signed calibration
pair. A synthetic +0.8/-1.2 g pair corresponds to a -0.2 g bias with unit
sensitivity and is covered by the new end-to-end capture/solve test. A uniformly
low ±0.82 g signal still fails Apply's unchanged scale bounds: the solver does
not quietly enlarge the scale allowance. A raw stationary 0.82 g reading alone
is neither proof of a defective sensor nor sufficient evidence to apply any
correction. Register configuration, sign, full six-face geometry and physical
repeatability must be checked; this patch does not establish the hardware cause.

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

Host tests cover engine mathematics, stationary/motion/noise gates, uncalibrated-gyro rejection of
0.82 g and uniform-low-sensitivity Apply rejection, nonfinite data, duplicate timestamps, timeouts/wrap, failed/cancelled
staging, register mismatch/data-ready behavior and manual-session expiration.
CLI tests cover exact face argument mapping and armed/motor/USB/health/config/
stale refusal. Configurator tests cover framing, allowlisting, strict parsing,
freshness, workflow gates, transaction serialization and generation invalidation.
Existing motor/DFU/settings suites are retained. Cross-build success and these
models do not prove physical calibration, sensor axes, actual FPS or flight
safety; verify the merged firmware/configurator pair on the props-off bench.
