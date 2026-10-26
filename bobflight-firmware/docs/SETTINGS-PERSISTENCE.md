# Settings persistence (schema 13)

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

Development firmware, not flight-qualified.

## Fresh install, not migration

Only schema 13 configuration is supported (`CONFIG_STORE_SCHEMA` 13, payload **256** bytes, `src/drivers/persist.c`). There are no loaders or migrations for schemas 1..12. Old, future or foreign records are not interpreted or automatically erased:

- An erased store (both slots blank) loads nothing and reports `last_error: empty` with `state: defaults`; the first Save writes a schema 13 record.
- `fresh_install_required` appears only when a slot holds an old, future or foreign record (BobFlight record header with another schema, board or payload size) and no valid schema 13 record exists. Load and Save then both report it.
- Any other unreadable, non-blank slot content reports `invalid_record`.
- With one valid schema 13 slot and one old-schema slot, load succeeds, but Save is still refused with `fresh_install_required` until the old slot is erased.
- Erase the internal configuration as part of a deliberate fresh installation, then re-enter receiver/map/modes/mounting and calibrate again. Do not paste an old dump wholesale; the Configurator rejects exports of any schema other than 13.

`diff all`, explicit `save` and verified reload remain supported. A schema migration framework is a separate, bench-tested change and does not exist yet.

## Schema 13 layout (256 bytes, little-endian)

| Bytes | Contents |
|---|---|
| 0..35 | Actual rates: `rate_max_*`, `rate_center_*`, `rate_expo_*` (roll, pitch, yaw) |
| 36..71 | `pid_{roll,pitch,yaw}_{p,i,d}` |
| 72 | receiver UART |
| 76..79 | map (AETR/TAER), mode count, control source, control mode |
| 80..111 | mode range rows |
| 112..143 | accelerometer calibration: flag 112, binding 116, bias 120..131, scale 132..143 |
| 144..171 | power configuration |
| 172 | DShot rate (300/600) |
| 176, 180 | `min_throttle`, `airmode` |
| 184, 188 | `gyro_lpf_hz`, `dterm_lpf_hz` |
| 192 | `loop_rate_hz` |
| 196..211 | `gyro_notch1_hz`, `gyro_notch1_cutoff_hz`, `gyro_notch2_hz`, `gyro_notch2_cutoff_hz` |
| 212..227 | `rpm_filter_harmonics`, `rpm_filter_min_hz`, `rpm_filter_q_x100`, `motor_poles` |
| 228 | `motor_direction` (0 props-out, 1 props-in) |
| 232..243 | `align_board_roll/pitch/yaw` (requested mounting) |
| 244..255 | mounting the accelerometer calibration is bound to |

Every field is validated before anything is applied; one bad field rejects the whole record.

## Defaults: one group at a time (D1)

`defaults <group>` resets only one Configurator tab's keys, in RAM. It never auto-saves, so storage goes dirty until an explicit Save.

| Group | Keys (reply order) |
|---|---|
| `pid` (11) | `pid_roll_p`, `pid_roll_i`, `pid_roll_d`, `pid_pitch_p`, `pid_pitch_i`, `pid_pitch_d`, `pid_yaw_p`, `pid_yaw_i`, `pid_yaw_d`, `min_throttle`, `airmode` |
| `rates` (9) | `rate_center_roll`, `rate_center_pitch`, `rate_center_yaw`, `rate_max_roll`, `rate_max_pitch`, `rate_max_yaw`, `rate_expo_roll`, `rate_expo_pitch`, `rate_expo_yaw` |
| `filters` (9) | `gyro_lpf_hz`, `dterm_lpf_hz`, `gyro_notch1_hz`, `gyro_notch1_cutoff_hz`, `gyro_notch2_hz`, `gyro_notch2_cutoff_hz`, `rpm_filter_harmonics`, `rpm_filter_min_hz`, `rpm_filter_q_x100` |

No group touches `align_board_*`, `motor_direction`, `motor_poles`, `loop_rate_hz`, DShot, power, ports/UART, receiver map, modes or the accelerometer calibration. Because the requested mounting never changes, a Save after `defaults <group>` keeps the calibration.

```
defaults pid   -> defaults_group: pid
                  defaults_key: pid_roll_p=0.002        (one line per key, exactly the `get` format)
                  ...
                  defaults_key: airmode=0
                  defaults_end: pid 11                  (count == number of defaults_key lines)
```

Refusals are a single line and change nothing, including the storage dirty flag. They are checked in this order:

1. The existing Blackbox refusal (`command refused: stop Blackbox recording ...`) while recording or reading the SD card.
2. `defaults_error: armed`, then `defaults_error: bench_active`, then `defaults_error: calibration_active`.
3. `defaults_error: group_required pid|rates|filters` for bare `defaults`; `defaults_error: unknown_group` for any other token.

`config_defaults()` (every key) runs only at boot.

## `storage` line `accel_cal_saved`

`storage` ends with `accel_cal_saved: yes|no` just before `storage_end: 1`. It is `yes` only when the last verified save (or boot load) record carries the accelerometer calibration. Saving while the requested mounting differs from the active mounting deliberately leaves the old-frame calibration out ([BOARD-ALIGNMENT.md](BOARD-ALIGNMENT.md)), and this line then reads `no`. Existing parsers ignore the extra field; the `saved: <backend> verified` reply is unchanged.

Apply edits to the controller, then explicitly Save to controller. Save verifies flash readback; reboot does not save unapplied browser drafts or unsaved runtime changes. No automatic flash writes on startup or slider movement.

## Tab audit

| Tab | Retained settings / behavior |
| --- | --- |
| Receiver / Ports | UART and AETR/TAER map in controller flash. Receiver has its own Save panel. Applying one field preserves the other draft. |
| Modes | All four mode ranges and manual/AUX control selection in flash. Unapplied row edits block this page's Save button. |
| PID / Rates | Supported gain/rate keys (including `pid_yaw_d`) in flash through existing explicit save flow. |
| Power & Battery | Divider, analog current scale/offset, cell count, warning/critical thresholds and capacity in flash. Consumption and measurements begin a new session after reboot. |
| Motors | DShot300/600 selection and `motor_direction` in flash. The firmware also stores `motor_poles` (RPM filter block); the Motors tab pole-count field is a separate browser preference. Test values, consent, sessions and motor activation are never restored. |
| Sensors | Validated applied accelerometer coefficients and binding remain in flash. Added Save panel. Gyro bias/readiness are measured at startup; candidate calibration and captures remain temporary. |
| Configuration / Failsafe | Disabled placeholder editors have no settings to persist. Removed the obsolete fixed-500ms claim from the Failsafe page; actual firmware behavior is unchanged. |
| Setup / Status / CLI | Read-only displays or explicit actions; CLI `save` commits the supported scope. `loop_rate_hz` is stored. CLI `defaults pid\|rates\|filters` resets one group in RAM (see below); bare `defaults` is refused. |
| Flasher / Connect | Connection/flash actions remain explicit; no automatic reconnect, reflash or controller write after reboot. |
| Blackbox | USB recordings remain browser-session data and must be downloaded. Recorder activity is not restored. |

Save panels require the connected firmware to advertise the relevant scope. Only schema 13 is read by the firmware and the Configurator. Unsupported targets (including current T-Motor F722) still refuse flash storage. Scope is capability, not evidence that current drafts were saved.

## Format and compatibility

Records use two independent erase slots with a CRC and a commit seal; Save writes the other slot and reads it back before reporting `saved: <backend> verified`. Future/foreign formats are rejected before the no-change save shortcut. Do not downgrade and assume newer settings remain readable.

Diff/dump exports include Power and DShot commands, including defaults for those groups. Applied accelerometer values remain diagnostic metadata, not replayable coefficient-setting commands. Gyro bias and live state are excluded. Flashing must preserve the reserved configuration sectors; mass erase destroys settings regardless of persistence support.

## Owner acceptance

After installing matching firmware/configurator, confirm `storage` reports schema 13 and backend flash, and that `version` matches the image you built. Set Receiver UART/map as needed and Apply each change, set a distinct Power value and Apply, then Save to controller. Confirm saved/dirty 0. Disconnect all controller power, reconnect, and check applied values, Modes and calibration. DShot persistence can be checked by selecting a supported alternate rate with motors stopped, saving, and power cycling; no motor test is necessary.

Save failure, unsupported storage or missing calibration is not success; retain the diagnostic output instead of erasing or repeatedly saving. Physical power-cycle acceptance is still required; software tests cannot verify the attached board.
