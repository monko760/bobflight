# Settings persistence (schema 14)

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.

Development firmware, not flight-qualified.

## Schema 14 (N3): append-only, one migration from 13

`CONFIG_STORE_SCHEMA` 14, payload **1024** bytes (`src/drivers/config_store.h`, `src/drivers/persist.c`).
Bytes 0..255 are the schema 13 layout below, byte for byte and validated by the same code. The rest is
an append-only extension:

| Bytes | Contents |
|---|---|
| 0..255 | schema 13 layout (unchanged offsets and meanings) |
| 256..259 | `layout_bytes` (LE32): how many leading payload bytes the writer's layout defines. N3 writes **260**. |
| 260..1023 | reserved, must be zero. Later settings append at `layout_bytes` and raise it. |

Record on flash: 32-byte header + 1024 payload + 32-byte commit block = **1088** bytes per slot (was 320).
Smallest slot on any board that has storage: Matek F722-PX, 16 KiB (sectors 1/2); Kakute F7 HDV uses
256 KiB slots (sectors 6/7); host_sim 256 KiB. T-Motor F7 V2 and the F405 images have no storage backend.

Headroom budget for the roadmap (estimates, not reservations; order follows merge order):

| Item | Estimate |
|---|---|
| N4 failsafe (hold window, cut/land, hold time limit, stick check) | ~16-24 B |
| N5 PID at idle with airmode off | ~4-8 B |
| N6 radio-switch modes (more rows, 8 B each) | ~64-160 B |
| N7 Angle/Horizon tuning | ~16-24 B |
| N8 DShot beacon | ~8 B |
| N9 battery and telemetry | ~16-64 B |
| total | ~124-288 B of 764 B free |

Load rules:

- `layout_bytes` must be a multiple of 4 in 260..1024 and every byte from `layout_bytes` to 1023 must be zero
  (`invalid_settings` otherwise).
- A shorter layout (older schema 14 firmware) loads; fields it lacks take their defaults.
- A longer layout (written by newer firmware) is refused with `last_error: newer_settings`; Save is refused
  too, so the newer record is never overwritten by firmware that would drop its fields.

### Migration 13 -> 14

- The store still reads a sealed schema 13 record (256-byte payload, same header, CRC and commit rules).
  Persist validates it with the schema 13 checks, keeps every byte 0..255, sets `layout_bytes` and fills
  any new field from defaults. Nothing is written at boot.
- `storage` then reports `schema: 14`, `state: saved` (the values in flash load identically on every boot)
  and `stored_schema: 13`. The schema 13 record stays in flash, untouched, until the next Save.
- Save writes a schema 14 record (generation + 1) into the other slot. The schema 13 record survives that
  first Save (a power cut at any byte leaves it loadable); the second changed Save replaces it.
- Schemas other than 13 and 14, a schema 13 record with another length, and foreign boards are still
  `fresh_install_required`: not migrated, not erased, Save refused.

### Downgrade

- Before any schema 14 Save: flash holds only schema 13, so schema 13 firmware loads it as before.
- After one schema 14 Save: schema 13 firmware loads the older schema 13 slot (settings as they were at
  migration time, later edits not visible) and refuses Save with `fresh_install_required`.
- After two schema 14 Saves: schema 13 firmware reports `fresh_install_required` and runs on defaults.
  Nothing is erased; upgrading again restores the schema 14 settings.

### `storage` line `stored_schema`

`stored_schema: 14|13|none` is the schema of the record the last load or verified save used: `13` means
migrated in RAM and rewritten as 14 on the next Save; `none` means nothing was loaded (erased store,
unsupported backend or an unreadable/incompatible record). It is printed after `accel_cal_saved`, just
before `storage_end: 1`.

## One defaults source

Every `set`/`get` key default lives in `CONFIG_DEFAULTS_INIT` in `src/flight/config.c`. Fresh boot (static
initializer), `config_defaults()`, `config_get_default_key()`, `defaults <group>` and the export `diff`
baseline all read it; the export keeps only its frozen key ORDER (`g_export_keys`). Mode-range defaults
live in one table (`mode_range_default()`), used by reset and by the export diff.
`tests/host_settings_schema14.c` checks fresh boot == defaults == `defaults <group>` == empty diff.

## Schema 13 layout (bytes 0..255 of schema 14, little-endian)

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

`storage` carries `accel_cal_saved: yes|no` after `flight_enabled` (followed by the N3 `stored_schema` line, then `storage_end: 1`). It is `yes` only when the last verified save (or boot load) record carries the accelerometer calibration. Saving while the requested mounting differs from the active mounting deliberately leaves the old-frame calibration out ([BOARD-ALIGNMENT.md](BOARD-ALIGNMENT.md)), and this line then reads `no`. Existing parsers ignore the extra field; the `saved: <backend> verified` reply is unchanged.

Apply edits to the controller, then explicitly Save to controller. Save verifies flash readback; reboot does not save unapplied browser drafts or unsaved runtime changes. No automatic flash writes on startup or slider movement.

## Tab audit

| Tab | Retained settings / behavior |
| --- | --- |
| Receiver / Ports | UART and AETR/TAER map in controller flash. Receiver has its own Save panel. Applying one field preserves the other draft. |
| Modes | All four mode ranges and manual/AUX control selection in flash. Unapplied row edits block this page's Save button. |
| PID / Rates | Supported gain/rate keys (including `pid_yaw_d`) in flash through existing explicit save flow. |
| Power & Battery | Divider, analog current scale/offset, cell count, warning/critical thresholds and capacity in flash. Consumption and measurements begin a new session after reboot. |
| Motors | DShot300/600 selection, `motor_direction`, and `motor_poles` in flash. The Motors tab sets `motor_poles` when the connected firmware advertises that key; a browser-only pole count is shown only when this firmware does not. Test values, consent, sessions and motor activation are never restored. |
| Sensors | Validated applied accelerometer coefficients and binding remain in flash. Added Save panel. Gyro bias/readiness are measured at startup; candidate calibration and captures remain temporary. |
| Configuration / Failsafe | Disabled placeholder editors have no settings to persist. Removed the obsolete fixed-500ms claim from the Failsafe page; actual firmware behavior is unchanged. |
| Setup / Status / CLI | Read-only displays or explicit actions; CLI `save` commits the supported scope. `loop_rate_hz` is stored. CLI `defaults pid\|rates\|filters` resets one group in RAM (see below); bare `defaults` is refused. |
| Flasher / Connect | Connection/flash actions remain explicit; no automatic reconnect, reflash or controller write after reboot. |
| Blackbox | USB recordings remain browser-session data and must be downloaded. Recorder activity is not restored. |

Save panels require the connected firmware to advertise the relevant scope. The firmware reads schema 14 and migrates schema 13; the Configurator side of schema 14 is pending the Config Lead key freeze. Unsupported targets (including current T-Motor F722) still refuse flash storage. Scope is capability, not evidence that current drafts were saved.

## Format and compatibility

Records use two independent erase slots with a CRC and a commit seal; Save writes the other slot and reads it back before reporting `saved: <backend> verified`. Future/foreign formats are rejected before the no-change save shortcut; a schema 13 record is always rewritten (never shortcut). See Downgrade above.

Diff/dump exports include Power and DShot commands, including defaults for those groups. Applied accelerometer values remain diagnostic metadata, not replayable coefficient-setting commands. Gyro bias and live state are excluded. Flashing must preserve the reserved configuration sectors; mass erase destroys settings regardless of persistence support.

## Owner acceptance

After installing matching firmware/configurator, confirm `storage` reports schema 14 (and `stored_schema: 13` on the first boot after upgrading, `14` after Save) and backend flash, and that `version` matches the image you built. Set Receiver UART/map as needed and Apply each change, set a distinct Power value and Apply, then Save to controller. Confirm saved/dirty 0. Disconnect all controller power, reconnect, and check applied values, Modes and calibration. DShot persistence can be checked by selecting a supported alternate rate with motors stopped, saving, and power cycling; no motor test is necessary.

Save failure, unsupported storage or missing calibration is not success; retain the diagnostic output instead of erasing or repeatedly saving. Physical power-cycle acceptance is still required; software tests cannot verify the attached board.
