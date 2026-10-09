# Relative yaw and the aircraft view

The Sensors view uses the firmware's three-angle `sensors` report. The new
optional `yaw_reference: gyro-relative` field identifies firmware that actually
integrates yaw. Older firmware remains usable for roll/pitch and calibration;
the updated UI marks yaw unavailable instead of presenting a permanent zero as
an implemented heading estimate. The existing two-angle `status` field is kept
unchanged for compatibility. Use `sensors` to inspect yaw.

## Estimation and control boundaries

Yaw integrates `(gyro_y * sin(roll) + gyro_z * cos(roll)) / cos(pitch)` using the
existing accepted sample interval and the already computed trigonometric terms.
It is relative to controller startup, wraps at +/-180 degrees, and drifts without
an external heading reference. Reboot resets it; reconnecting the UI does not.
The existing limited-tilt estimator can refuse updates near vertical pitch.

No heading hold, north reference, arming changes, motor commands, or flight
qualification are introduced. The yaw control setpoint remains stick-to-rate.
Calibration storage, aircraft mounting configuration and schema 11 are unchanged.
Wrapping is bounded and adds no per-sample trigonometric calls, but physical loop
timing still needs checking on the target. Software timing tests are not hardware
cycle measurements.

## Aircraft representation

The view applies body roll, then pitch, then world yaw (`Rz * Ry * Rx`). A solid
blue arrow and FRONT label identify the nose; a dashed tail and BACK label identify
the rear. Labels stay upright and use leader lines when they need separation.
The numbering is the logical QUADX mixer convention, not proof of ESC wiring:

| Motor | Aircraft position |
| --- | --- |
| M1 | Rear-right |
| M2 | Front-right |
| M3 | Rear-left |
| M4 | Front-left |

Stale, disconnected, unhealthy or unready attitude data does not display a live
orientation. The representation is read-only and sends no motor/config commands.

## Props-off confirmation

1. Before an update, keep the last working HEX, export `diff all`, and check that
   calibration has been explicitly saved. Configuration exports contain calibration
   metadata, not a replayable replacement for the saved calibration coefficients.
2. Update both the configurator and target firmware. The configurator's Build HEX
   flow must target the actual board. Do not erase the whole chip or reset defaults.
3. If software `bl` entry fails, stop and report it; do not assume ROM DFU entry
   or recovery has been verified on this board. Use only a previously verified
   recovery method and the last working image if recovery becomes necessary.
4. With the board stationary and level after a full power cycle, capture `status`,
   `sensors`, `storage`, and `diff all`. Check saved accelerometer correction and
   active/configured mounting agree, gyro calibration completes, and level
   acceleration is approximately +1 g on Z with near-zero X/Y and roll/pitch.
5. Keep the board roughly level and turn clockwise when viewed from above: the
   nose should turn right, with approximately +90 degrees for a quarter turn.
   Counterclockwise should decrease yaw. Watch for smooth wraparound at +/-180.
   Gyro drift is expected; no absolute heading accuracy is claimed.
6. Verify that roll/pitch directions still agree, labels remain attached to their
   aircraft positions, and stationary timing/overrun readouts do not regress.
   Stop on inconsistent directions, unhealthy/stale telemetry or new overruns.
