# Settings persistence (schema 6)

Schema 6 extends schema 5 with `pid_yaw_d` (float LE, default **0.00005**, clamp **0..10** finite like other `pid_*` D gains). Schema 5 (and older) records load with this default and mark dirty until an explicit Save.

Payload is **188** bytes: schema-5 bytes 0–183 unchanged (160–163 `min_throttle`, 164 `airmode`, **165–175 remain reserved / zero — do not overload**, 176–179 `gyro_lpf_hz`, 180–183 `dterm_lpf_hz`), then **184–187** `pid_yaw_d`. `MAX_PAYLOAD` is 192.

Schema 5 was 184 bytes (gyro/dterm LPF). Schema 4 was 176 bytes (`min_throttle` + `airmode`). Not flight-qualified.


Apply edits to the controller, then explicitly Save to controller. Save verifies flash readback; reboot does not save unapplied browser drafts or unsaved runtime changes. No automatic flash writes on startup or slider movement.

## Tab audit

| Tab | Retained settings / behavior |
| --- | --- |
| Receiver / Ports | UART and AETR/TAER map in controller flash. Receiver has its own Save panel. Applying one field preserves the other draft. |
| Modes | All four mode ranges and manual/AUX control selection in flash. Unapplied row edits block this page's Save button. |
| PID / Rates | Supported gain/rate keys (including `pid_yaw_d`) in flash through existing explicit save flow. |
| Power & Battery | Divider, analog current scale/offset, cell count, warning/critical thresholds and capacity in flash. Consumption and measurements begin a new session after reboot. |
| Motors | DShot300/600 selection in flash. Pole count remains a browser preference for RPM estimates. Test values, consent, sessions and motor activation are never restored. |
| Sensors | Validated applied accelerometer coefficients and binding remain in flash. Added Save panel. Gyro bias/readiness are measured at startup; candidate calibration and captures remain temporary. |
| Configuration / Failsafe | Disabled placeholder editors have no settings to persist. Removed the obsolete fixed-500ms claim from the Failsafe page; actual firmware behavior is unchanged. |
| Setup / Status / CLI | Read-only displays or explicit actions; CLI `save` commits the supported scope. `defaults` retains its existing PID/rates-only meaning. |
| Flasher / Connect | Connection/flash actions remain explicit; no automatic reconnect, reflash or controller write after reboot. |
| Blackbox | USB recordings remain browser-session data and must be downloaded. Recorder activity is not restored. |

Save panels require the connected firmware to advertise the relevant scope. Older schemas remain readable by the configurator; they cannot claim to save Power/DShot/LPF filters/`pid_yaw_d`. Unsupported targets (including current T-Motor F722) still refuse flash storage. Scope is capability, not evidence that current drafts were saved.

## Format and compatibility

Schema 3 stores 160 bytes: unchanged schema-2 configuration/calibration bytes 0–127, seven power fields at 128–155, DShot rate at 156–159. All fields are validated before application. A failed DShot rate restore reports an error and does not claim a successful configuration restore. The existing bench-only flash restrictions remain.

Schema 1 (96 bytes) and schema 2 (128 bytes) migrate only on explicit Save. Existing receiver/modes/PID/calibration values are retained; newly supported Power/DShot settings start at established defaults. The prior slot remains until the new CRC-checked record is committed in its separate 32-byte programming region. Future/foreign formats are rejected before the no-change save shortcut. Do not downgrade and assume newer settings remain readable.

Diff/dump exports include Power and DShot commands, including defaults for those groups. Applied accelerometer values remain diagnostic metadata, not replayable coefficient-setting commands. Gyro bias and live state are excluded. Flashing must preserve the reserved configuration sectors; mass erase destroys settings regardless of persistence support.

## Owner acceptance

After installing matching firmware/configurator, confirm `storage` reports schema 6 and backend flash. Set Receiver UART/map as needed and Apply each change, set a distinct Power value and Apply, then Save to controller. Confirm saved/dirty 0. Disconnect all controller power, reconnect, and check applied values, Modes and calibration. DShot persistence can be checked by selecting a supported alternate rate with motors stopped, saving, and power cycling; no motor test is necessary.

Expected Kakute version: `0.2.0-prototype-switchbench2-bl1-calstore2-piddiag2`. Save failure, unsupported storage or missing calibration is not success; retain the diagnostic output instead of erasing or repeatedly saving. Physical power-cycle acceptance is still required; software tests cannot verify the attached board.
