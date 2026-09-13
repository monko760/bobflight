# Ports and Modes: bench configuration

> Historical increment. For current Angle/Acro/Level (Horizon) routing, API-2 semantics and safe installation checks, see [Flight modes](FLIGHT-MODES.md). Persistence remains a separate task.

This development increment replaces the configurator's disabled Ports/Modes placeholders with firmware-backed configuration and explicit readback. It does not make BobFlight flight-qualified.

## Supported scope

- **Ports:** firmware-reported USB/UART inventory, pin labels and the current CRSF receiver assignment. USB remains the fixed CLI connection. Only UARTs advertised as selectable by this firmware can be selected; GPS, MSP, VTX and general-purpose telemetry roles are not implemented.
- **Modes:** ARM and ANGLE AUX range previews, receiver freshness, and range-match information. This build explicitly reports `semantics: preview`: edits do not alter arming or select Acro/Angle control. Existing control-loop behavior is unchanged.
- **Apply then Save:** UART and mode edits initially change RAM. On a supported flash backend, explicit verified Save persists them; otherwise they remain session-only. Changes are refused while armed or while bench motor activity is present. See [persistent storage, backups and installation tests](PERSISTENCE.md).

Read [firmware API and mode behavior](bobflight-firmware/docs/PORTS-MODES.md) for the implemented commands, defaults and safety semantics.

## Build and validation

Build the configurator with `npm ci` followed by `npm run build` in `bobflight-configurator`. Use `npm run dev` to start its local Vite server.

The repository-root `build-ports-modes.ps1` helper builds a Kakute F7 HDV HEX on Windows using the existing tool layout or tools on PATH. It explicitly sets `BOBFLIGHT_FLIGHT_ENABLE=OFF`, `BOBFLIGHT_ACCEL_BENCH_RELAXED=OFF` and `BOBFLIGHT_BOOT_LED_DIAGNOSTICS=OFF`. It never flashes.

A Linux equivalent from the repository root is:

```sh
cmake -S bobflight-firmware -B bobflight-firmware/build-ports-modes-kakute \
  -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake \
  -DBOBFLIGHT_BOARD=kakute_f7_hdv \
  -DBOBFLIGHT_FLIGHT_ENABLE=OFF \
  -DBOBFLIGHT_ACCEL_BENCH_RELAXED=OFF \
  -DBOBFLIGHT_BOOT_LED_DIAGNOSTICS=OFF
cmake --build bobflight-firmware/build-ports-modes-kakute -j 4
```

Host tests and a successful cross-build are software checks, not hardware validation. Windows helper execution is not covered by Linux testing.

## Props-off verification

Keep a known-good recovery image, remove propellers, and follow your established flashing/recovery procedure. After reconnecting:

1. Refresh Ports and confirm board identity, selected UART and its RX/TX pins against your wiring. Change the CRSF assignment only to a supported, physically wired receiver UART. Check fresh frames and mapped controls on Receiver.
2. Refresh Modes, check the reported semantics and flight lock, then configure each AUX range. Verify the readback and refresh with the transmitter switch at each position. Range-active is distinct from armed; a bench build must not be treated as flight-enabled.
3. Power-cycle/reboot, reconnect and confirm defaults are restored. Verify receiver loss does not show active/live ranges. Older firmware without the new API should produce a disabled/error state, not invented data.

The orientation-dependent accelerometer discrepancy reported during earlier bench work is outside this change. No sensor calibration coefficients, timing qualification, motor direction or flight safety claims are made here.
