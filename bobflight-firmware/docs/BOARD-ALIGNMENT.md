# Aircraft board mounting orientation

The factory `gyro_align` in a board target describes the IMU relative to the stock
board frame. Do not edit it to describe an individual aircraft installation.
`align_board_roll`, `align_board_pitch`, and `align_board_yaw` are additional,
persistent aircraft settings, each a whole degree between -180 and 180. Defaults
are zero. The setting names intentionally resemble familiar Betaflight names;
they are independently implemented and the rotation convention below is explicit.

## Operation

After the fixed factory transform, both gyro and acceleration pass through the
same proper rotation `Rz(yaw) * Ry(pitch) * Rx(roll)`. Positive rotations follow
the right-hand rule with X forward, Y right, and Z down. Roll is applied first,
then pitch, then yaw. This is before gyro bias measurement/subtraction,
accelerometer calibration, attitude estimation, and PID consumers. Sensor-register
bytes and `accel_counts` remain untouched sensor-frame diagnostics. `accel_raw_g`
is now the resulting aircraft-frame value before calibration correction.

The rotation is activated only during startup, after complete configuration
restore and before the first IMU sample. Trigonometry is performed once at boot;
each active sample uses a bounded matrix-vector multiplication. This does not
claim zero timing cost. Zero mounting bypasses the multiply. Set/defaults change
the requested values, never the live matrix. Diagnostics explicitly report
configured values, active values, and whether a reboot is required.

Use Sensors > Aircraft board orientation, or explicit CLI commands (no equals sign):

```text
set align_board_roll 180
set align_board_pitch 0
set align_board_yaw 0
save
```

Check `saved: flash verified`, then issue `reboot` or remove **all** power. Save
and reboot are separate operations. Values are included in `diff all`/`dump all`.
Setters require disarmed, no active motor test and no manual calibration session.
Calibration is refused while mounting changes await reboot. No arming/failsafe
logic or flight-enable setting is changed by this feature.

## Matek F722-PX example

The owner identifies stock mounting as ICs down. For ICs up with the stock front
still pointing toward the aircraft front, use roll 180, pitch 0, yaw 0. This flips
Y and Z, not just Z. If the board is also backward/sideways relative to the
nose, configure yaw accordingly. Aircraft-specific yaw settings, such as an
existing 180-degree installation, must not become board-target defaults.

After reboot the previous approximately +3581 sensor-frame Z counts should remain
approximately +0.874 g in the aircraft frame for this installation, rather than
being displayed as negative Z. The rotation cannot change vector magnitude.
Do not expect +1 g until a valid stationary, level accelerometer calibration.

## Calibration and storage

Schema 11 keeps the existing 256-byte payload and flash layout. Bytes 232..243
store requested roll/pitch/yaw floats. Bytes 244..255 bind valid accelerometer
coefficients to their aircraft-frame angles. The existing sensor/resource/range
binding remains mandatory as well. The record is validated before restore.

Saving while requested mounting differs from active mounting deliberately excludes
the old-frame accelerometer correction. It remains active in RAM in the old
frame only until reboot. Recalibrate after reboot and Save again. Old gyro bias
is never restored from flash; startup measures it in the new frame. A subsequent
return to stock mounting does not resurrect a discarded old correction.

Schema 1..10 records migrate to zero additional mounting, preserving valid prior
calibration and other settings. Migration is dirty until explicit Save. Schema 10
reserved mounting bytes must be zero; malformed data is not silently repaired.
Partial, failed or interrupted flash writes use the existing two-slot commit/CRC
protection. Calibration frame mismatch rejects the record atomically.

**Downgrade warning:** older firmware cannot read schema 11 records. It may select
an older compatible slot if one remains, or report invalid storage. Back up
`diff all` before updating. Do not mass erase to address this. Return to the
mounting-capable firmware to access saved settings. Old firmware also cannot
represent the new mounting correction; do not assume it is retained on downgrade.

## Props-off acceptance checks

1. Verify firmware suffix `-mount1`, storage schema 11, retained receiver UART/map,
   and no unexpected setting changes. Initial schema migration may report dirty.
2. Apply the desired angles and inspect configured versus active values. The
   model must not jump merely because values were staged. Save and fully reboot.
3. Confirm active equals configured and `board_align_reboot_required: no`.
4. With the board upright, tip nose up/down and roll right/left. The model must
   follow each physical direction. Stop on reversed or swapped axes.
5. Let startup gyro calibration finish. On a genuinely level, stationary surface,
   perform level accelerometer calibration, then explicit Save. Check approximately
   zero stationary gyro, near-zero level X/Y acceleration and approximately +1 g Z.
6. Remove all power and reconnect. Confirm mounting and accelerometer correction
   restore, and separately confirm live CRSF reception with receiver/transmitter
   powered. This is not evidence of correct wiring when those devices are off.
7. Compare `status`/`timing`: retain target/actual loop rate and no new overruns.
   Verify guarded `bl` with saved settings and no active calibration. Stop for
   USB resets, storage errors, wrong axes, or timing regressions. Use the known
   physical BOOT recovery path if software bootloader entry is unavailable.

Software tests and sparse-HEX validation are not physical axis, timing, or flight
qualification. All new hardware checks remain the operator's bench test.
