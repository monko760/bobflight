# Attitude loss never disarms in the air (N1)

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

Software only. No flashing, bench or flight qualification is implied.

## Defect

The Euler roll/pitch estimator in `flight/attitude.c` gave up when
`cos(pitch) < 0.1` (about 84 degrees), and `loop_pid()` disarmed whenever Angle,
Horizon or staged HOLD/LAND lacked attitude. A 600 deg/s full-stick pitch flip
in Horizon therefore lost attitude near 84 degrees and disarmed in the air.

## Estimator

- Body-to-earth quaternion (x forward, y right, z down), integrated with the
  exact rotation increment per sample. No pitch singularity: pitch through
  +/-90 degrees, inverted flight and full flips/rolls stay valid. Roll/pitch/yaw
  are derived from the quaternion only as outputs (`attitude_degrees()`).
- Gravity seeding works at any pose, including vertical.
- Accelerometer correction uses the same gravity window as before
  (0.8-1.2 g) with a 2 rad/s gain (the previous 0.5 s time constant).
- Trust state, `attitude_state()` / `attitude_state_name()`:
  - `valid`: the only state in which `attitude_ready()` is true.
  - `uninitialized`: not seeded yet, or reset by a rejected gyro/time sample.
  - `accel-invalid`: non-finite accelerometer data; gyro propagation continues.
  - `gravity-timeout`: no in-window gravity sample for
    `ATTITUDE_GRAVITY_TIMEOUT_S` (10 s) of gyro-only propagation.
  - `recovering`: gravity is back; a faster 10 rad/s correction runs for
    `ATTITUDE_RECOVER_S` (0.5 s) of in-window samples before `valid`.
- Rejected gyro/time samples are unchanged from #103: they invalidate the
  estimate without integrating it.

## Control fallback

| Situation (armed) | Before | Now |
| --- | --- | --- |
| Angle/Horizon, attitude not `valid` | disarm | rate (Acro) control on the valid gyro; pilot sticks give rate demands |
| HOLD/LAND, attitude not `valid` | disarm | zero body-rate hold at the failsafe throttle |
| HOLD/LAND, attitude valid but gravity unqualified (`gyro_flight_ready()` false) | disarm | zero body-rate hold at the failsafe throttle (no fake leveling) |
| Any mode, invalid gyro or time, DShot unhealthy, bad PID interval | disarm | disarm (unchanged) |
| Acro | gyro only | gyro only (unchanged) |

Leveled control resumes automatically on the first controller pass after the
estimate is `valid` again. Failsafe's own stage timers (DROP, land timer)
still stop the motors. HOLD/LAND without attitude hold the current angle rather
than level; that is the chosen trade-off against dropping the craft.

On the ground nothing changes: leveled arming is still refused without valid
attitude and within 20 degrees of level. Disarmed, no fallback is reported.

## Readout (names frozen with Config Lead)

Adding a reason or `attitude_state` value is a contract change: the strict
Configurator parser rejects the whole `modes` reply. Coordinate first.

`modes` (modes_api 2, additive keys after `mode_conflict`):

```
level_fallback: 0|1
level_fallback_reason: none|attitude-invalid|failsafe-gravity-unqualified
level_fallback_count: <engagements while armed since boot>
attitude_state: valid|uninitialized|accel-invalid|gravity-timeout|recovering
```

While `level_fallback: 1`, `effective_mode` is `acro` and Blackbox logs the
effective mode as Acro. The Configurator Modes tab shows the state; the offline
mock omits the keys and is shown as not reported.

## Tests

- `attitude_flip_rate_fallback` (`tests/host_attitude_flip.c`): actual tasks,
  estimator, Horizon and PID with a kinematic truth model. 600 deg/s Horizon
  full-stick pitch flips through 90, 180 and 360 degrees and back, a roll flip,
  a zero-g flip and an Angle excursion: never disarmed, never in fallback, tilt
  error under 2 degrees, leveled control resumes. Accelerometer-invalid and
  gravity-timeout fallback with timed recovery. Invalid gyro mid-flip still
  disarms, does not advance the filter and invalidates attitude.
- `control_mode_routing`, `attitude`, `attitude_yaw` updated for the new
  semantics; `.github/scripts/ports-modes-contract.cjs` checks the new keys from
  the real host firmware through the Configurator parser.

## Known limits

The complementary filter still trusts any in-window accelerometer sample. During
sustained thrust in a flip, the accelerometer can read near 1 g along body z and
pull the estimate toward level. Tuning that (for example a rate gate on the
correction) belongs to Angle/Horizon tuning (N7).
