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
Kakute F7 HDV. Flight arming is disabled in the tested build — **this is not
flight-qualified firmware.** See [BASELINE.md](BASELINE.md) for the
hardware-verified starting point.

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
