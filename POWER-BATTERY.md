# Power & Battery bench implementation

Based on main ddfa3ef (merged failsafe, DShot, bench safeguards and motor configurator).
Branch: feature/power-battery. Flight arming remains OFF in the supplied build.

## Implemented

- ADC1 software conversions, PC3 voltage and PC2 external analog current input.
- Nonblocking 20 Hz sampling, 10 ms conversion timeout, 500 ms stale-data rejection.
- Pack voltage, average cell voltage, optional amps/watts/mAh and estimated capacity remaining.
- Configurable voltage divider, current mV/A and zero offset, cell count, capacity and warning thresholds.
- Dedicated `power` reply with API version and end marker, separate from sensor status.
- `power_config <divider> <mV/A or 0> <offset_mV> <cells or 0> <warning_V> <critical_V> <capacity_mAh>`.
  Changes are atomic, rejected while armed or a bench test is active, and read back.
- Unknown firmware, absent battery and missing/stale sensor data are displayed explicitly.

## Calibration and limits

Voltage assumes 3.3 V ADC reference and initial divider 11. Compare against a multimeter;
the UI calculates a corrected multiplier. Cell count is explicit (0 = unconfigured),
avoiding ambiguous automatic detection on discharged packs. The Kakute board supports
up to 6S; no battery or ESC model is hardcoded into the measurement logic.

Current defaults OFF. An external analog current sensor must be wired to the current
input and must measure the whole pack. Formula: A = max(0, (ADC_mV - offset_mV)/mV_per_A).
These units are not the Betaflight CLI scale/offset units. No simulated current from
throttle, ESC telemetry, or bidirectional DShot telemetry is implemented.

Consumption is an estimate since boot, pack insertion, or configuration change.
It resets on pack removal and cannot account for consumption before monitoring started.
A missing interval invalidates the total until the next pack or configuration session.
Capacity remaining assumes the session began with a full pack. Current calibration must
be verified independently before using this estimate.

Settings are RAM-only, matching the existing firmware persistence implementation;
they reset at reboot. Warnings are configurator notices, not motor cutoff or receiver
failsafe actions. Audible/OSD/receiver warnings, persistent profiles and ESC telemetry
are future work. Hardware readings and USB cold boot need bench verification.

## Review findings outside this change

In src/sched/tasks.c, loop_pid passes a local sticks array to failsafe_command_override,
but loop_mixer_dshot reads throttle again from rx_channels. LAND override throttle thus
does not reach the mixer. Unit tests of the failsafe state machine do not verify this
integration. Resolve with an end-to-end cascade test before enabling flight.

## References

- Board pin facts: https://github.com/betaflight/unified-targets/blob/master/configs/default/HBRO-KAKUTEF7HDV.config
- STM32F745 ADC registers: ST RM0385 section 15, https://www.st.com/resource/en/reference_manual/dm00124865.pdf
- UI feature comparison: https://betaflight.com/docs/wiki/app/power-tab

## Verification

Build host firmware and run CTest. Run configurator typecheck, then:
`node bobflight-configurator/ui/scripts/test-power.cjs <absolute path to bobflight_host.exe>`.
This tests the actual firmware reply against the UI parser, including rejected config.
Cross-build with cmake/stm32f745.cmake, kakute_f7_hdv and BOBFLIGHT_FLIGHT_ENABLE=OFF.
