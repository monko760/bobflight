# Separate gyro validity from Euler attitude availability

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

## Confirmed defect

On main `2575a58` (after CI PR #102), `loop_gyro()` replaced the result of
`gyro_sample()` with `attitude_update()`'s result. The latter rejects an
unavailable gravity solution and its Euler pitch singularity near vertical.
`loop_pid()` then disarmed every mode on that combined flag, including Acro.

This contradicted the current gyro-only Acro arming policy in `arming.c` and
`MAIN-BUILD.md`. No accelerometer calibration or Euler attitude is needed for
body-rate Acro control. Before this patch, a regression using the actual task
and estimator code, with mock receiver/arming/motor endpoints, failed at
`arm == ARM_ARMED` for a valid gyro and vertical acceleration vector.

An older control-mode test explicitly expected disarm at the singularity even
in Acro. That expectation came from the earlier shared-attitude control path;
this patch replaces it with mode-specific tests rather than removing coverage.

## Change

- Keep gyro/time validity separate from attitude-estimator availability.
- Acro uses valid finite body-rate samples without requiring the Euler solution.
- Angle, Horizon and staged HOLD/LAND still require valid attitude. Failsafe
  leveling also retains the existing qualified-gravity check.
- A rejected/nonfinite gyro sample, zero/backward gyro timestamp, or a sample
  gap above the existing 10 ms bound disarms and invalidates attitude.
- First-sample timing has an explicit initialized flag, so timestamp zero is
  not confused with an uninitialized epoch. Exactly 10 ms remains accepted.
- Invalid gyro/time does not advance persistent LPF/notch/RPM DSP state. The
  filtered output is zeroed for the invalid sample. A valid gyro still advances
  the chain when only its accelerometer/Euler solution is unavailable.
- The separate PID elapsed-time guard, ARM-edge requirement, receiver freshness,
  manual calibration restrictions, DShot health and low-throttle/AirMode policy
  remain in place. No automatic re-arm or mode change is introduced.

## Regression coverage

The task-level tests cover both vertical directions, absent gravity, NaN/Inf
accelerometer inputs, and valid gyro processing in Acro. The same scenarios
must disarm Angle and Horizon. HOLD/LAND cannot inherit Acro's exemption.
All modes still reject failed gyro reads and nonfinite gyro components; invalid
samples do not reach the filter. Timestamp tests cover genuine first epoch zero,
repeated/backward time, an over-10-ms gap, the inclusive 10-ms boundary and
recovery. Existing PID-divider and real filter-chain tests remain.

Two fixtures previously rewound a live mock clock without resetting task static
state. They now either test epoch zero at actual startup or keep time monotonic
across fixture/rate reinitialization; the new rejection is not suppressed.

## Scope, timing and portability

Only `src/sched/tasks.c` changes runtime behavior. There are no new dependencies,
board pin mappings, target capabilities, clock drivers, scheduler policies,
default loop rates, filter coefficients, gain settings or motor limits.
The shared task logic is tested across the existing native board matrix and
cross-compiled for the current F7 targets. This does not make TMotor sensor-only
or F4 diagnostic targets flight controllers, or enable Matek flight arming.

This is a frame-validity correctness fix, not a measured CPU-speed improvement.
The estimator still runs for telemetry; it has not been replaced or downsampled.
The existing MPU cached-sample freshness policy is unchanged. Before claiming
optimal hardware timing, profile real stage execution and deadlines under
receiver, USB and logging load on each target. No flight qualification or
performance gain is claimed by the host tests.

## Provenance

Implementation and regressions are original changes to existing Apache-2.0
BobFlight code. No external flight-controller implementation was consulted or
copied; no GPL source or new dependency was added. This scoped review is not a
complete audit of historical repository provenance.

## Validation on this change

- 160/160 native tests on each of dummy, Kakute F7 HDV, TMotor F7 V2 and
  Matek F722-PX: 640 passing executions of the shared suite, not 640 distinct tests.
- Official pinned ARM GNU 14.2.rel1 builds for all three current F7 targets.
- Matek sparse-image/config-sector check passed.
- Control routing, PID elapsed time and full gyro post-filter-chain tests passed
  with AddressSanitizer and UndefinedBehaviorSanitizer.
- The parent reviewed the implementation and tests. The background reviewer
  reached its execution limit without a substantive report; no independent
  final-patch signoff is claimed. Hardware timing/flight validation is pending.
