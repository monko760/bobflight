# Startup LED diagnostics

Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0

## Normal builds: blocking success patterns OFF

`BOBFLIGHT_BOOT_LED_DIAGNOSTICS` is a CMake option, default **OFF**. Normal
builds omit the reset-handler success blinks, main-entry pulse, post-board
pulse, clock-source display/hold, and post-USB chirps. These patterns used
busy-wait loops and blocked startup before the USB serial port could appear.

The LED is still configured after board initialization, and the existing
nonblocking main-loop heartbeat remains. Sticky boot-stage breadcrumbs,
fault-handler LED codes, reset vector setup, and FPU enable are retained.
The separate `BOBFLIGHT_PROVE_RESET=ON` reset-only diagnostic is unchanged:
it intentionally blinks forever and never starts the application or USB.
Do not use that diagnostic for a normal bench firmware build.

No changes to the clock tree, oscillator/PLL timeout loops, USB hardware
settling or disconnect/connection sequence, compiler optimization, gyro,
scheduler, DShot driver, motor caps, stop/deadline checks, or flight-arming
policy are included. In particular, the existing app-level 20 ms and 5 ms
USB settle requests remain even though the optional LED waits are removed.
The clock source remains available through the existing `status` command.

## Enable the old blocking display for troubleshooting

Configure a separate build directory with:

```sh
cmake -S bobflight-firmware -B build-kakute-led-debug \
  -DCMAKE_TOOLCHAIN_FILE=cmake/stm32f745.cmake \
  -DBOBFLIGHT_HOST_SMOKE=OFF \
  -DBOBFLIGHT_BOARD=kakute_f7_hdv \
  -DBOBFLIGHT_FLIGHT_ENABLE=OFF \
  -DBOBFLIGHT_PROVE_RESET=OFF \
  -DBOBFLIGHT_BOOT_LED_DIAGNOSTICS=ON
cmake --build build-kakute-led-debug
```

`ON` restores the successful-start LED patterns and their blocking waits.
This is intentionally diagnostic, not a faster boot mode. The header defaults
the flag to zero for direct builds that omit CMake's compile definition.

## Validation and measurement boundaries

Host preprocessor regression coverage exercises default/OFF/ON and combinations
with prove-reset, checks live function bodies rather than comments, and guards
the retained fault/stage/settle paths. Cross-builds with diagnostics OFF, ON,
and prove-reset are also checked by inspecting their linked functions/calls.
Host tests cannot measure MCU boot speed or Windows USB enumeration.

The earlier 6–10 second report is a user observation. Estimates based on loop
counts and guessed cycles per iteration are not measurements and do not
establish a guaranteed duration or target. Removal of the waits is expected
to reduce time before USB attach; it does not guarantee 1–3 second COM-port
appearance on every host.

After the reviewed PR is merged, use a matching bench build. With all props
removed and the battery disconnected, compare USB-only cold-plug-to-COM time
across several runs using the same cable and port. Record COM appearance
separately from configurator connection/first successful `status` response.
Check a normal reset separately from leaving DFU; direct bootloader handoff
need not have the same initial conditions. Confirm normal heartbeat and USB
status, and retain the known-working previous HEX for comparison. This change
is not flight qualification or a change in motor-test authorization.
