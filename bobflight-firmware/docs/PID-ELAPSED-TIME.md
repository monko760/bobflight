# PID elapsed-time correction

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

Based on merged main ba8b717 (receiver PR14 and timing PR15 retained).
Confirmed defect: loop_pid passed the latest gyro interval to pid_set_dt even
when several gyro cycles elapsed between PID invocations. I accumulation and
D scaling therefore used the wrong time at PID dividers greater than one.

loop_pid now timestamps its own entry and uses the elapsed microseconds since
its previous eligible invocation. No configured-rate approximation is used.
After startup, disarm, or low throttle, it primes one invocation with cleared
PID correction rather than inventing a first dt. This does not stop collective
throttle in an armed mixer; it skips PID correction for that priming slice.
Zero, backward or >=20000us intervals disarm, clear the arm edge latch and PID
state, and never pass stale dt to PID. The strict upper bound matches the
existing pid_set_dt domain. Existing independent gyro-gap checks are unchanged.

The current app stays at 1000Hz/divider1. No gyro clock/sample/estimator changes,
rate/Acro routing, gain tuning, receiver/UART/failsafe implementation, calibration,
flash persistence, motor-test limits or watchdog changes are included. PID engine
math is unchanged; only its obsolete comment was corrected. Receiver and timing
PRs are ancestors, and their dedicated implementation files remain unchanged.

Validation: 30/30 host tests pass. A new native test exercises the actual task
entrypoints with deterministic microsecond time and simulated arming/PID endpoints:
dividers1/2/4/8, variable delays, low-throttle reset, zero timestamp startup,
zero/backward/20ms refusal, 19999us acceptance, and crossing a32-bit boundary.
It checks the dt passed to PID; it is not a closed-loop flight simulation.
Strict C11 -Wall -Wextra -Werror plus ASan/UBSan passes. Standard and relaxed
F745 cross-builds pass, with linked flight arming disabled. Existing motor,
receiver, calibration and timing tests still pass. No configurator changes.

Review: original Apache-2.0 code/tests only; no dependencies or third-party/GPL
source imported. Focused parent review, not an independent final-patch or full
repository GPL audit. Hardware PID behavior and flight safety remain unqualified.
The remaining angle-only control path, RAM-only storage and sensor qualification
are separate milestones. Robert will review/merge this PR; no unmerged HEX is
being supplied. Work pauses after the push until he resumes it.
