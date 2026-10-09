# Matek F722-PX bring-up

This target is for the F722-PX, not the F722-WPX. It is not flight-qualified.
Motor output, battery/current ADC, barometer, FrSky OSD, external flash logging,
SD logging and receiver telemetry transmission are not implemented here.
Normal arming, receiver freshness, sensor health and failsafe rules are unchanged.

## Implemented candidate

- STM32F722RE / 512 KiB identity check; 8 MHz HSE reference default, not a physical measurement.
- Conservative F722 168 MHz clock path; shared TinyUSB CDC and CLI.
- MPU6000 SPI1: PA5/PA6/PA7, CS PB2, DRDY PC4. Mounting is
  `CW180_DEG_FLIP`, mathematically diag(1,-1,-1), a proper rotation.
  This is sensor mounting, not Robert's aircraft-specific 180-degree yaw setting.
- CRSF 420000 baud, default UART2 (receiver TX to board RX2/PA3).
  Advertised receiver choices are UART1/2/3/4. UART6 belongs to onboard Pixel OSD;
  UART5 has no driver and is not selectable. Verify receiver power and common ground.
- Betaflight-style `diff all` and `save`, internal MCU flash settings.
- Existing guarded `bl` / `bl discard` software ROM-entry path extended to this board.
  Physical USB startup, sensor direction, cold-boot Save and `bl` remain hardware checks.

## Settings layout and HEX requirement

F722 RM0431 sectors 1 and 2 are independent 16 KiB erase units:
slot 0 at 0x08004000, slot 1 at 0x08008000. ST's corrected sector facts are also
recorded in [STM32CubeF7 issue 56](https://github.com/STMicroelectronics/STM32CubeF7/issues/56).
The vector table remains at 0x08000000; text begins at 0x0800C000. The linker
reserves both slots, and the image validator rejects data in either slot.
The ordinary two-slot settings codec retains CRC, board-tag and atomic-commit checks.
Erase/write operations reject armed, motor-bench or manual-calibration activity.
Same-bank flash erase stalls execution; this is maintenance, not a real-time operation.
The shared watchdog maintenance window and interrupt/cache restoration are retained.

**Use the sparse HEX only. No Matek BIN is generated.** The browser flasher writes
and erases only actual HEX regions. Flattening into BIN, whole-chip erase or flashing
other firmware may erase settings. Export `diff all` before future updates.
The 32 MB external flash mentioned by Matek is separate and is not used for settings.

## Local target builder

Start `start-configurator-builder.ps1` from the tested checkout. Select
**Matek F722-PX** in Flasher Stage 2, then **Build HEX** in Stage 3.
Compile, download and flash remain separate actions. Verify board ID
`matek_f722_px`, matching source revision and the displayed SHA-256.
A clean committed checkout and the existing local ARM/Python/CMake toolchain are required.

## First hardware test

1. Props off, no ESC/motor power; start USB-only. Verify the physical BOOT button
   makes the board enumerate as STM32 ROM DFU before installing this candidate.
   Save any existing configuration if needed; this does not back up firmware itself.
2. Select the exact target and build. Enter ROM DFU using BOOT and flash the HEX with
   readback verification. Disconnect USB fully, then reconnect without BOOT.
3. Connect CLI. Run `version`, `status`, `ports`, `receiver`, `diff all`.
   Expect the Matek version/board identity, responsive CLI, MPU6000 detection, and
   the four advertised UARTs. No receiver connected means no valid receiver link.
4. Check gyro/accel responsiveness and all three directions, including upright versus
   inverted gravity. Wrong direction, missing gyro, repeated resets or nonfinite data
   is a stop condition, not a calibration workaround.
5. Record `rate_expo` using `get rate_expo`. Set it to a different valid value, `save`,
   power-cycle and read it back with `get rate_expo` and `diff all`. Restore the original
   value and `save`. Verify a chosen UART and channel order also survive a cold boot.
6. With a correctly powered CRSF receiver, verify channel movement and link loss
   when the transmitter is switched off. Do not arm. UART2 is the initial default.
7. With settings saved, motors stopped and calibration inactive, run `bl`.
   Expect CDC to disconnect and STM32 ROM DFU to enumerate. If it fails, stop and
   use physical BOOT recovery; do not call software recovery verified.

A passing software model or compile does not prove these physical checks.

## Calibration workflow update (`cal2`)

The new firmware identifies itself with the `-cal2` version suffix and advertises
`calibration_api: 2`. Calibration controls require the paired configurator.
A level accelerometer offset is now the primary workflow; the six-face solve is
advanced. The current upright-negative-Z hardware observation is NOT fixed by
this update, and level calibration must refuse it. Do not turn the board upside
down to make that check pass. See [calibration details](../../docs/SENSOR-CALIBRATION.md).

Before updating, end any active session (`calibration_cancel`) and export `diff all`.
Use the sparse HEX only and the existing verified `bl`/physical BOOT recovery path.
After full power removal and reconnect, verify version `-cal2`, `storage`, `receiver`,
and `calibration`. Expect the previous saved generation and TAER to survive, a live
CRSF link when the transmitter is on, and separate gyro offset-applied/readiness
indicators. Do not assume a successful earlier gyro calibration persists across boot.

Keep the board upright/stationary and copy the new `accel_register_bytes`,
`accel_counts`, range, aligned pre-correction and corrected fields. Negative aligned
Z is an expected stop condition for level calibration until mounting is resolved.
Gyro calibration may be tested independently: keep still, observe a completed
window and near-zero rotation rates. This does not calibrate the accelerometer.

Compare `status` timing before/after opening detailed diagnostics: target/actual
1000 Hz, no new overruns, no resets or telemetry framing loss. Verify `bl` again
with saved settings and no active calibration session. If USB or storage regresses,
stop; recover via physical BOOT and the previous PR #88 sparse HEX. Do not mass erase.
Do not call the new calibration hardware-validated until these checks are observed.
