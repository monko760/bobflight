# Ports and Modes API 1 — bench preview

> Historical increment. For current Angle/Acro/Level (Horizon) routing, API-2 semantics and safe installation checks, see [Flight modes](../../FLIGHT-MODES.md). Persistent saving and backups are documented in [Persistence](../../PERSISTENCE.md).

This increment adds firmware-backed port selection and session-only mode-range **previews**. It does not change the existing arming, PID, attitude, failsafe, or motor-control paths. The unverified control-loop edits from earlier drafts were removed. ARM/ANGLE range configuration does **not** select the actual arm switch or enable Acro/Angle switching in this build.

## Exact wire contract

`ports` returns `ports_api: 1`, `board`, `receiver_uart`, `reboot_required: no`, `persistence: flash` (or `session` on unsupported/simulated backends), `armed`, `bench_active`, port rows, and the final `ports_end: 1` line. All lines are CRLF terminated. A row is `port: id,label,txPin,rxPin,role,selectable`. IDs are numeric: **0** for USB, **1/2/3/4/6/7** for supported Kakute UARTs. Labels are human-readable, e.g. USB_VCP/UART6. USB is fixed CLI, with no MCU pins invented. UART pin labels mirror the existing Kakute board selector; UART7 has no advertised TX pin. Other board targets do not advertise additional selectable UARTs.

`receiver_uart N` selects an existing supported CRSF UART only when disarmed and no bench motor activity is pending. The change is immediately applied, receiver freshness is invalidated by the existing reset path, and the host must read `ports` again to verify it. The current channel-order setting is not explicitly overwritten by this feature.

`modes` returns `modes_api: 1`, `persistence: flash` (or `session` on unsupported/simulated backends), **`semantics: preview`**, `flight_enabled`, `armed`, `bench_active`, `rx_fresh`, exactly one ARM row and one ANGLE row, and final `modes_end: 1`. A row is:

```text
mode: ARM,1,1,1751,2100,0
```

The fields are mode name, enabled 0/1, **numeric AUX index 1–12**, minimum, maximum, and range-active 0/1. AUX1 is `rc[4]` and AUX12 is `rc[15]` in zero-based C arrays. The configurator displays AUX labels but serializes only the number.

```text
mode_range ARM 1 12 1100 1450
```

The command above configures the ARM **preview** on AUX12. Values are equivalent microseconds derived from normalized channel data, not measured PWM pulses. Bounds are inclusive and must satisfy `900 <= min < max <= 2100`. Invalid, overflowing, signed, fractional, extra, or missing parameters are refused before mutation. Edits while armed or during active/pending motor-bench work are refused. Success returns a full modes snapshot; the UI checks exact readback. Refusals begin `mode_range refused:`.

Defaults: ARM enabled, AUX1, 1751–2100; ANGLE enabled, AUX2, 900–2100. Edits initially live in RAM. Explicit verified `save` persists these settings on the supported flash backend; unsaved edits are lost on reboot. Consult `storage` for dirty/error/backend state and [the persistence guide](../../PERSISTENCE.md) before installation. `defaults` remains the existing PID/rates defaults command, not a reset for these preview settings.

## Safety and scope

A range match is not an arm command, actual mode selection, or proof of safety. Invalid or stale RC values cannot produce an active preview. The UI uses manually refreshed snapshots, visibly labels them as snapshots, blocks edits while disconnected/armed/bench-active, and discards replies from old connections. Older unsupported firmware remains non-editable rather than receiving fabricated capability data.

The mock exposes only USB and labels itself `source: mock`; it does not pretend to bind physical UARTs or receive live RC. Mock preview settings reset on reconnect as well as reboot. On real hardware USB reconnect alone does not imply a firmware reboot.

The supplied Kakute image is compiled with flight disabled, relaxed accelerometer calibration disabled, and boot LED diagnostics disabled. Software tests and a cross-build do not establish hardware or flight qualification. Sensor offset/calibration work is separate and is not included here.
