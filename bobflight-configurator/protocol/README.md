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
- defaults -> defaults restored CRLF (RAM only; does not auto-save)

Keys: rate_max_roll/pitch/yaw, rate_expo, pid_roll_p/i/d, pid_pitch_p/i/d, pid_yaw_p/i.


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
