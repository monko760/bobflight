# BobFlight

> **Current Kakute workflow:** [One main build: flash, configure, props-off PID check](MAIN-BUILD.md). Use `build-main.ps1` and `bobflight-kakute_f7_hdv-main.hex`. Any bench/development profile commands below are historical and retired; normal runtime guards still apply.

Clean-room flight controller firmware and browser configurator, developed
against the Holybro Kakute F7 HDV (STM32F745).

- `bobflight-firmware/` — C firmware, board definitions, host smoke build,
  cross build, and tests.
- `bobflight-configurator/` — TypeScript browser configurator (Web Serial /
  USB CDC) and CLI protocol with modeled DFU flashing.

## Status

Bench-verified baseline: USB connection and live sensor telemetry on the
Kakute F7 HDV. **This is not flight-qualified firmware.** See
[BASELINE.md](BASELINE.md) for the hardware-verified starting point and
[MAIN-BUILD.md](MAIN-BUILD.md) for the current Kakute props-off workflow.

## Configurator on main

`bobflight-configurator/` is a TypeScript browser UI (Vite + React) over the
text CLI (Web Serial / USB CDC), plus a mock transport used by tests. Screens
that ship:

- Connect, Setup, Ports, Configuration, Power & Battery, Failsafe, Receiver,
  Modes, Motors, Sensors, Blackbox, Status, Rates, PID, Filters, CLI, Flasher.

PID and Filters are real `get` / `set` / `save` screens, with per-tab
`defaults pid`, `defaults rates`, and `defaults filters`. Filters includes the
gyro and D-term low-pass, two gyro notches, and the RPM filter
(`rpm_filter` and the `rpm_filter_*` settings) when the connected firmware
reports them. Blackbox is in the UI: a low-rate USB snapshot recorder
(JSON/CSV), onboard `blackbox` start/stop/status, SD probe, and download of
onboard `.BBL` files the firmware exposes. None of that is a flight-qualified
logger.

Honest limits that are still true on main:

- GPS, MSP, VTX, and telemetry port roles are not implemented. Ports edits the
  CRSF receiver UART only.
- Configuration does not edit feature flags, board alignment, DShot rate, or
  mixer type. Alignment is on Sensors. DShot rate and motor direction are on
  Motors. The `mixer` command is a read-only report.
- Modes selects Angle, Acro, and Level manually. Angle, Acro, and Level AUX
  ranges are stored and do not select the mode. AUX mode-range routing is
  retired. A configured ARM range is the arm switch.
- Failsafe procedure and RX-loss timeout are not editable. The page shows
  `status` failsafe only.
- Accelerometer calibration (`calibrate_accel`) is on the Sensors tab. Setup
  does not send it.
- On current firmware, `diff` and `diff all` print the same changed-settings
  report. There is no profile split. The configurator export sends `diff all`.
  `dump` and `dump all` likewise print the same full report.

## Building

Firmware host smoke build and tests (no MCU, runs on desktop):

```sh
cd bobflight-firmware
cmake -B build && cmake --build build
ctest --test-dir build --output-on-failure
```

Firmware for the Kakute F7 HDV (requires `gcc-arm-none-eabi`):

```sh
cd bobflight-firmware
cmake -B build -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake -DBOBFLIGHT_BOARD=kakute_f7_hdv
cmake --build build -j
```

Configurator (Node 20+):

```sh
cd bobflight-configurator
npm ci
npm run build
```

CI runs all of the above on every push (see the badge or the Actions tab).

## Attribution and license

BobFlight is an independent implementation, written from scratch with AI
assistance and inspired by the architecture of Betaflight and other open
flight controller projects — it is not a fork of Betaflight.

Both components are Apache-2.0; see the `LICENSE` and `NOTICE` files in
`bobflight-firmware/` and `bobflight-configurator/`. Vendored dependencies
in `bobflight-firmware/third_party/` retain their own licenses.
