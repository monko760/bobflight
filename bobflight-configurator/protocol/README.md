# @bobflight/protocol

Host-side USB CDC serial transport for BobFlight Configurator (clean-room, Apache-2.0).

Path B: line-oriented CLI only (no third-party FC binary protocol).

## Build

See package scripts: build and smoke.

Default baud: 115200.

## Smoke

Package script `smoke` builds then runs scripts/smoke.ts against MockSerial.
Asserts connect never sends arm; exercises version, status, help.

Package script `smoke:settings` exercises get/set/save/defaults for the
FW-locked first-12 settings keys (exact reply shapes, no spaces around `=`).

## Proposed API

BobFlightCliClient methods:
- enumeratePorts()
- connect({ path, baudRate?, transport? }) — never auto-arms
- disconnect()
- sendCommand(cmd, opts?) where cmd is help|version|status|arm|disarm|reboot
- sendRaw(line, opts?) for free-form lines (settings)
- onLine(cb) / onStatus(cb)
- getVersion() / getStatus()
- arm() / disarm() / reboot() for UI-confirmed calls only
- configureReconnect(...)
- **Settings (first-12 keys):**
  - getSetting(key) -> { key, value }
  - setSetting(key, value) -> { key, value }
  - saveSettings() -> void (acks saved)
  - restoreDefaults() -> all 12 after reset (defaults restored, no auto-save)
  - getAllSettings() -> Record of all 12

ConnectionStatus: disconnected | connecting | connected | reconnecting | error

Also exported: enumeratePorts, parseStatus, parseVersionLine, MockSerial,
MOCK_PORT_PATH, transport factories, isSerialportAvailable, Web Serial helpers, framing helpers,
SETTINGS_KEYS, DEFAULT_SETTINGS, parseGetReply / parseSetReply / parseSaveReply /
parseDefaultsReply, SettingsKey.

Arm fail-closed gate (`failClosed`): gyro_ok:no and/or failsafe:ACTIVE only. arm:disarmed is normal safe state (not a gate). mmio:denied is informational.

### Settings CLI contract (exact)

- get <key> -> <key>=<value> CRLF or unknown key CRLF
- set <key> <value> -> ok <key>=<value> CRLF | unknown key CRLF | set failed CRLF
- save -> saved CRLF | save failed CRLF
- defaults <group> (D1; group is exactly pid|rates|filters; RAM only, no auto-save; storage goes dirty) ->
  `defaults_group: <group>` CRLF, then one `defaults_key: <key>=<value>` CRLF per key in exactly the
  `get` format, then `defaults_end: <group> <count>` CRLF where count == number of defaults_key lines.
  pid = pid_{roll,pitch,yaw}_{p,i,d}, min_throttle, airmode (11); rates = rate_center_*, rate_max_*,
  rate_expo_* (9); filters = gyro_lpf_hz, dterm_lpf_hz, gyro_notch{1,2}_hz, gyro_notch{1,2}_cutoff_hz,
  rpm_filter_harmonics, rpm_filter_min_hz, rpm_filter_q_x100 (9). No group touches align_board_*,
  motor_direction, motor_poles, loop_rate_hz, DShot, power, ports, map, modes or accel calibration.
- defaults refusals (one line, nothing changes, dirty flag included), in order: the Blackbox
  `command refused: ...` line; `defaults_error: armed` | `bench_active` | `calibration_active`;
  bare `defaults` -> `defaults_error: group_required pid|rates|filters`; any other token ->
  `defaults_error: unknown_group`. The legacy `defaults restored` reply no longer exists, so
  `restoreDefaults()`/`parseDefaultsReply` must move to the group form (Configurator follow-up).
- storage: additive `accel_cal_saved: yes|no` line just before `storage_end: 1` (yes only when the last
  verified save/boot-load record carries the accelerometer calibration). `parseStorage` ignores it;
  the `saved: <backend> verified` reply is unchanged.

Keys: see SETTINGS_KEYS; the schema 13 layout is in bobflight-firmware/docs/SETTINGS-PERSISTENCE.md.



## Storage schema (host contract)

Schema 5 payload is 184 bytes (includes gyro/dterm LPF). Schema 6 is **188** bytes:
`pid_yaw_d` LE float at bytes **184..187** (default `0.00005`, validate `0..10` finite).
Migration 5→6 writes that default; reserved 165–175 and LPF 176–183 are left untouched.

## Web Serial (browser)

Chrome/Edge USB CDC via `navigator.serial` (secure context only: HTTPS or localhost).

- `isWebSerialAvailable()` / `webSerialUnavailableReason()`
- `WebSerialTransportFactory.enumerate()` uses `getPorts()` (already-granted ports)
- `requestPort(filters?)` must run from a user gesture (picker dialog)
- Paths use scheme `webserial:<id>`; `AutoTransportFactory` opens those paths when available
- Mock remains the default smoke path (`mock://bobflight`); Node has no Web Serial

## Real hardware

Optional native serial module when available; otherwise use mock://bobflight.

## License

Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0.
