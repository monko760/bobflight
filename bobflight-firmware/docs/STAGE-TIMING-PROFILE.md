# Bounded scheduler stage profiling

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

## Purpose and scope

This is a diagnostic step toward measuring frame costs, not a speedup claim or
flight qualification. Existing `timing` reports task rates, gaps and whole-slice
maxima, but cannot separate filter, PID, motor-output and background work.

The new profiler is OFF by default. A native clock-read counter verifies that
OFF scheduling uses exactly the previous number of `hal_micros()` reads, with
unchanged invocation order, across 1/2/4/8 kHz and dividers 1/2/4/8. There are
additional state checks; zero extra timestamp reads does NOT mean zero CPU cost.

No loop-rate defaults, PID gains, scheduler deadline/divider policy, motor limits,
calibration policy or board capabilities change. Existing safety and adaptive
rate guards remain active. Profiling can itself cause a guard to reduce the loop
rate; the profiler stops on that change and neither suppresses nor reverses it.
This change is independent of Acro validity PR #103, which still requires review.

## CLI and operation

With props removed, disarmed, and no motor bench active:

1. Run `timing` for the normal baseline.
2. Run `timing_profile start`.
3. Wait at least three seconds, then run `timing_profile` to read the capture.

`timing_profile stop` ends an active capture early. Starting a new capture clears
the old one; a refused start preserves it. Repeated start while running is refused.
The protocol accepts only those three exact commands. Simulation replies report
unavailable/mock hardware and never fabricate measurements.

Start requires an initialized scheduler and a functioning high-resolution HAL
clock. The capture stops on arming, motor bench activity, loss of clock health,
clock reversal, rate change, or its roughly three-second window. These are
cooperative checkpoints, not a preemptive timer: a callback crossing the deadline
can finish and be recorded before capture stops. Profiling does not block a
normal arm request; it stops measuring. Stats freeze after capture ends.

The same CLI poll can stop and restart a session. A generation check prevents
an old in-progress callback or its tail from being charged to the new capture.

## Meaning of the report

Every report ends with `timing_profile_end: 1`. It contains state, target and
observed capture duration, the configured gyro rate/PID divider at capture start,
and per-stage invocation count, total time, maximum time and integer mean:

- `gyro`: the existing gyro task, including its existing estimator work.
- `filter`: gyro-filter/post-filter callback.
- `pid`: PID task including its guards/diagnostics, not necessarily a PID update.
- `motor_output`: mixer/output callback, not proof of ESC frame transmission.
- `rx`, `failsafe`, `cli`: the scheduler's existing background callbacks.
- `outside_scheduler_gap`: elapsed gap from the last measured scheduler return
  checkpoint to the next entry. It includes other main-loop work such as USB,
  logging and telemetry; it does not identify which of those caused a delay.

Durations are wall time including interrupt/preemption time, not CPU utilization.
Counts are task/callback invocations, not fresh sensor samples or valid control
updates. `mean_us` is integer microseconds; zero can mean below timer resolution.
An unobserved stage has zero count and `mean_us=unavailable`.

The disarmed PID and output paths are not equivalent to armed flight workload.
This profiler intentionally does not measure armed control. Existing zero-output
bench diagnostics, if separately enabled, add their own work to the measured
stage and must not be mistaken for ordinary flight cost.

While active, extra clock reads and accounting can perturb timings and create
skips/overruns or reduce background slack. Existing lifetime timing maxima and
fault counters include that perturbation and are not cleared afterward. Compare
baseline/capture/after-capture `timing` and `loop_rate` results. A capture alone is
not a justification for raising rates or relaxing guards.

## Implementation and verification

All profile state is foreground-owned, statically allocated and accessed through
the existing HAL clock. No IRQ, dynamic allocation, hardware timer ownership or
platform-specific cycle-counter access is added. The report is bounded to a
1,600-byte formatter buffer; existing `timing` framing is unchanged.

Native regression coverage includes:

- Exact default-OFF timestamp counts and task sequence across all rate/divider
  combinations listed above.
- Known injected costs for every stage and the outside gap, without counting the
  gap as scheduler execution or duplicating RX/failsafe calls.
- Busy/armed/motor/low-resolution/uninitialized refusals and preserved prior data.
- Cooperative expiry (including a callback crossing the boundary), manual stop,
  mid-callback arming, clock failure/reversal, rate change and restart isolation.
- Wide counter/report bounds, complete framing and real host CLI dispatch.
- Exact client allowlists, split/truncated frames and honest mock behavior.

Native task fixtures lacking a clock-health symbol use an explicitly test-only
HAL stub; it is not linked into firmware. The dedicated profile test supplies
mutable health/arming/motor state for negative coverage.

A focused read-only test-plan review highlighted observer overhead and false
CPU-utilization interpretations. Its suggested numerical overhead estimates were
not hardware measurements and are not used as claims here. Parent review and
tests do not constitute independent final-patch approval or flight qualification.
No external flight-controller code or new dependency was imported; the original
implementation retains Apache-2.0 headers. Comprehensive provenance review remains
separate from this scoped change.
