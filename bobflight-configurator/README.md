# BobFlight Configurator

Apache-2.0 clean-room configurator for BobFlight flight controllers.

Independent implementation. Not a fork of Betaflight Configurator. Do not
copy or paste GPL MSP trees or Betaflight Configurator sources into this repo.
See NOTICE.

This tree is not flight-qualified. Props stay off for bench checks.

## Stack

- Language: TypeScript
- Workspaces: `protocol/` and `ui/`
- UI: Vite + React + TypeScript
- Transport: USB CDC text CLI (Web Serial), plus a mock transport for tests

## Screens on main

The shell tabs are: Flasher, Connect, Setup, Ports, Configuration,
Power & Battery, Failsafe, Receiver, Modes, Motors, Sensors, Blackbox,
Status, Rates, PID, Filters, and CLI.

PID and Filters are implemented. They read and write with `get` / `set` /
`save`. Each of PID, Rates, and Filters has its own Defaults action
(`defaults pid`, `defaults rates`, `defaults filters`). Empty numeric fields
stay empty; they are not sent as zero. Save stays off until the draft differs
from the last successful read, and it stays off while storage cannot be saved
or the post-flash gate is up.

Filters covers:

- Gyro LPF and D-term LPF (`gyro_lpf_hz`, `dterm_lpf_hz`)
- Two manual gyro notches when the firmware reports them
- The RPM filter (`rpm_filter`, `rpm_filter_harmonics`, `rpm_filter_min_hz`,
  `rpm_filter_q_x100`) when the firmware reports it

With no connection, or when a read does not succeed, Filters leaves those
fields blank. It does not fill the local 320 Hz / 53 Hz demo memory.

Blackbox is implemented as a tab, not a deferred placeholder. It has a
low-rate USB snapshot recorder (JSON/CSV from supported read-only commands),
onboard `blackbox start` / `blackbox stop` / `blackbox status`, an SD card
probe (`sd probe`, `sd status`, `sd cancel`), and a download of onboard
`.BBL` files through guarded `sd read`. That is not a flight-qualified logger,
and a demo port has no physical card.

## What the firmware on main actually honors

- Ports: USB stays the CLI port. The editable control is the CRSF receiver
  UART (`receiver_uart`) on a UART the firmware marks selectable. GPS, MSP,
  VTX, and telemetry roles are not implemented and have no controls.
- Modes: `control_mode angle|acro|horizon` selects the mode. A configured ARM
  range (`mode_range ARM`) is the guarded arm switch. Angle, Acro, and Level
  ranges are stored and are not used to select a mode. `control_source aux`
  is refused. The page does not offer inputs for those dead ranges.
- Configuration: read-only `status` crumbs only. Feature flags, board
  alignment, DShot rate, and mixer type are not edited here. Alignment is on
  Sensors (`align_board_roll`, `align_board_pitch`, `align_board_yaw`). DShot
  300/600 and motor direction are on Motors. `mixer` is a read-only report.
- Setup: loop rate, gyro health, and arming blockers. Accelerometer
  calibration is on the Sensors tab (`calibrate_accel level` and the six-face
  `calibrate_accel` commands). Setup does not send a calibration command.
- Failsafe: `failsafe` from `status` only. Procedure and timeout are not
  editable.
- CLI export: the storage panel sends `diff all` for changed settings and
  `dump all` for the full supported set. On current firmware, `diff` and
  `diff all` print the same changed-settings report, and `dump` and
  `dump all` print the same full report. There is no profile split.

## Layout

```
bobflight-configurator/
  LICENSE NOTICE GOVERNANCE.md CONTRIBUTING.md SECURITY.md
  README.md package.json tsconfig.base.json
  protocol/
  ui/
```

## Quick start

From `bobflight-configurator` (Node 20 or newer):

```sh
npm ci
npm run build
npm run dev
```

The Vite dev server prints a local URL (port 5173 unless that port is taken).
Connect a CDC port from the Connect tab, or use a mock port when a test or
demo calls for it. The UI does not arm on connect.

## License

Apache-2.0. See LICENSE and NOTICE.
