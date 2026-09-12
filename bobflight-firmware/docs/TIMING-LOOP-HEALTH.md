# Microsecond timebase and scheduler diagnostics

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

## Scope and confirmed defects

Initially based on `9b00ffd`; rebased onto receiver PR #14 merge `c810b5d`. Previously F7 `hal_micros()` was `g_ms * 1000`,
so its apparent microsecond API had only millisecond resolution and rolled
back when the 32-bit millisecond counter wrapped. The scheduler set every new
deadline to `now + period`; late starts drifted the schedule and the following
catch-up condition compared an already-future deadline against `now`.

This change addresses those gaps, not calibration, receiver transport, Acro,
PID tuning, persistent settings, bidirectional DShot or flight enablement.
The application still requests **1000 Hz with PID divider 1**. Timer DMA, motor
limits (35%), pulse duration (one second), watchdog and arming policies remain
unchanged. Scheduler integration necessarily shares `scheduler.c`; coordinate
that file and small CLI/type/CI additions with the receiver agent before merge.

## F7 clock

After the existing PLL selection, `hal_time_init()` enables trace and Cortex-M7
DWT CYCCNT via the existing Apache-licensed CMSIS definitions. It unlocks the
DWT, checks counter availability and verifies advancement with a bounded probe.
It anchors to the existing count rather than resetting a debug-owned counter.
No peripheral timers are claimed or reconfigured.

At the supported 16/168/216 MHz clock paths, whole microseconds and fractional
cycles accumulate without per-read rounding drift. SysTick and foreground reads
fold unsigned 32-bit cycle deltas into the same 64-bit elapsed time under short,
PRIMASK-preserving critical sections. This also protects a preemptible fallback
SysTick from another ordinary interrupt reading half-updated state. NMI/fault
handlers must not call these APIs.

A CYCCNT wrap occurs after about 268.44/25.57/19.88 seconds respectively; folding
must happen strictly more often than one full wrap (not a half-wrap signed
comparison). Millisecond SysTick folding supplies that service during normal
execution. Keeping fractional cycles is essential. Tests exercise repeated
wraps, UINT32_MAX deltas, fractions, duplicate reads and masks already set.

The existing clock-init-before-time-init order avoids counting the PLL transition
at the wrong rate. Changing SystemCoreClock at runtime, removing trace enable or
disabling the counter latches an explicitly low-resolution fallback; do not
reconfigure clocks live. Unsupported frequencies, dummy MMIO denial, missing or
stuck counters at initialization also use fallback. The fallback extends the
millisecond ticks to 64-bit microseconds and clamps against the last returned
value, never silently pretending to provide high resolution. `hal_time_init()`
explicitly starts a new epoch, so monotonicity is between initializations.

This is running-core elapsed time, not a wall clock across debugger halts or
sleep. No counter can reconstruct multiple entirely unobserved wraps. Runtime
counter stoppage with its enable bits still set is not independently detected;
this and debug/sleep operation are not qualified. Physical frequency accuracy,
critical-section latency, IRQ loading and DWT behavior must be measured on board.
Fallback is for diagnostic/legacy bench operation, not a flight qualification.

`hal_millis()` retains the original SysTick watchdog/lease semantics. It is not
silently migrated to DWT. POSIX host simulation now uses CLOCK_MONOTONIC rather
than wall-clock gettimeofday; Windows retains QPC with overflow-safer conversion.
Host clock failures latch unhealthy metadata and clamp returned time. Host
CPU frequency is reported as unknown (0), not invented.

## Scheduler and telemetry semantics

The scheduler advances from the previous deadline to the first future grid
slot. It counts skipped slots and executes at most one gyro task / one PID
cascade per call; it never replays missing samples. The existing receiver and
failsafe polling order is retained. PID division counts actually executed gyro
tasks. Late starts can still yield a short next interval to regain phase, but
not a burst replay of all old slots. Invalid frequency >1 MHz uses the existing
8 kHz default rather than generating a zero-microsecond period; normal app
configuration is unchanged.

Type `timing` in the configurator CLI. The updated read-only command is explicitly
allowlisted and framed by `timing_end: 1`; truncated replies are rejected, old
firmware unknown-command replies remain readable, and mocks return unavailable
rather than made-up timing. No new auto-polling or streaming is introduced.

- `timebase`, `time_high_resolution`, `core_clock_config_hz`: source, startup/
  enable health and software-selected core frequency (not a frequency counter).
- `gyro_config_hz`, `gyro_period_us`, `pid_denom`: configured/effective schedule.
- `gyro_task_hz`, `pid_task_hz`: completed invocation counts divided by elapsed
  time since scheduler initialization, unavailable for the first second.
  These are NOT successful fresh IMU samples, accepted PID updates, ESC packets,
  or sensor output-data-rate measurements. Long-term averages can hide recent
  changes; use repeated queries and the interval/counter fields too.
- Intervals: actual task-start spacing; `*_interval_valid` distinguishes no
  interval yet from an observed zero. Min/max and maximum absolute deviation
  from configured period are since initialization, not RMS/standard deviation.
- `start_lateness_max_us`: lag behind the earliest unserved deadline, including
  skipped slots. `skipped_gyro_slots` counts full unserved schedule slots.
- `gyro_exec_max_us`: gyro task execution including its existing estimator work.
  `cascade_exec_max_us`: the complete due slice from its observed start, including
  instrumentation, but not preceding receiver polling or following CLI work.
  `cycle_overruns` counts slices taking strictly longer than the gyro period.
  Intervals include those outside-slice delays. Duration extrema saturate at
  UINT32_MAX; wide counters remain 64-bit. Stats reset at scheduler_init/reboot.

The reporting command itself consumes foreground time. Nonzero jitter/overruns
under heavy CLI traffic are observations, not automatically a sensor fault.

## Tests and review

29/29 host tests pass after receiver integration, including pure accumulator math, the actual F7 clock code
with simulated CMSIS core registers, deterministic scheduler delays/phase/divider
checks, and bounded CLI output with maximum-width counters. New clock/scheduler
sources also pass strict C11 -Wall -Wextra -Werror and ASan/UBSan. Timing/sensor/
motor protocol suites, protocol smoke, 11 sensor UI groups, 28 motor UI tests,
receiver UI tests, production configurator build, and both standard/relaxed F745 builds pass.
Linked arming is disabled in both bench builds. Motor DMA, gyro/calibration,
PID/mixer/arming and bench-task object bytes were compared against the previous
relaxed build and are unchanged. Clock and scheduler objects intentionally differ.

The background reviewer completed a focused baseline architecture review of
wrap extension, frequency changes, atomicity, phase preservation and truthful
telemetry. Parent implementation/review additionally preserves fractional cycles,
uses a wide fallback, avoids resetting CYCCNT, and uses full-width lateness.
The review's suggested half-wrap bound is unnecessarily strict for unsigned
delta accumulation; the actual requirement is less than one full wrap. This is
not an independent final-patch signoff or a complete repository license audit.
All new code/tests are original Apache-2.0; no third-party source, new dependencies
or GPL implementations were imported. Existing dependencies remain unchanged.

One additional confirmed architecture gap remains deferred: `loop_pid()` passes
its latest gyro sample interval to PID even if PID divider is greater than one.
That is not the elapsed interval between PID executions. Current divider 1 is
unchanged; do not raise the divider for flight until PID timing is addressed.
Angle-only routing and RAM-only persistence also remain separate milestones.

## Bench acceptance after merge

Build from the verified merged commit with flight OFF, normal startup LEDs,
and the same explicit relaxed-calibration option as the previously supplied
bench image if preserving that bench policy. No HEX is delivered from an
unmerged feature branch. With props removed, verify normal USB reconnection and
`timing` reporting `dwt-cyccnt`, high resolution yes and a plausible configured
core frequency. Capture timing after idle and after ordinary CLI/USB traffic;
check intervals/rates/skips before increasing workload. If fallback is reported,
stop timing qualification and investigate rather than hiding the failure.
No calibration recaptures are requested in this milestone; that work is paused.

## Receiver PR preservation check

PR #14 (`c810b5d`) is an ancestor of this branch. Of its 25 changed files,
18 are byte-identical to that merge, including CRSF, RX, failsafe, UART,
ReceiverPage, parser, mock and receiver tests. The remaining seven shared files
retain the receiver edits and only add timing dispatch/types/mock responses,
framing and CI/build test entries. The two rebase conflicts were adjacent
command-list additions; both receiver and timing entries were retained.
Receiver host and UI tests, all 29 host tests, timing/sensor/motor protocol
suites, sensor/motor UI groups and production builds pass after integration.
This establishes source preservation and tested compatibility, not physical
receiver behavior or hardware timing qualification. No receiver implementation
was replaced, and no flight enablement or calibration changes were added.
