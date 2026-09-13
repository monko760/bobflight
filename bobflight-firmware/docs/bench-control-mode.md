# Experimental bench control-mode routing

This connects the existing Acro rates mapper to the existing rate PID. It is **not flight qualification**, a completed Acro implementation, or an accelerometer correction. Flight arming remains disabled in the normal bench build. No PID gains are changed.

## CLI

```
control_mode
control_mode acro
control_mode angle
```

Angle is the boot default. The selection is RAM-only, is not included in `save`, and returns to Angle after reboot. The existing `defaults` command resets rates/PID configuration, not this separate volatile selector; explicitly use `control_mode angle` to clear it without reboot. Query output has a `control_mode_version: 1` header, selected `control_mode`, `control_mode_storage: ram-only`, `control_mode_experimental: yes`, and `control_mode_end: 1` terminator. This new name is separate from the existing safety `flight_mode: bench-only` label.

Changes require disarmed state, no active/pending motor test, and no manual sensor calibration. Unknown or extra arguments are rejected. Acro selection is refused in a build with `BOBFLIGHT_FLIGHT_ENABLE=1`; this patch does not enable that option.

## Control behavior

- Angle continues to use the existing attitude-to-rate outer loop.
- Acro maps stick commands through configured deadband, expo and maximum rates to degrees/second setpoints. The existing rate PID compares these with filtered gyro degrees/second.
- Existing staged failsafe override retains Angle leveling commands even when Acro is selected. Selection remains Acro, and its setpoint routing resumes when the override clears. No failsafe state/timing/throttle rules are changed.

Measured PID elapsed time, first-cycle priming, low-throttle reset, health checks, mixer and arming decisions remain unchanged. The controller still resets while disarmed, so a no-motor bench session does **not** exercise an active physical PID loop. Deterministic host tests exercise the real routing and PID with mocked arming/RX/motors.

The attitude estimator is still a loop-health/arming dependency, including its pitch singularity rejection. Consequently this is **not gyro-only, unrestricted Acro flight support**. Do not attempt flips or flight based on this patch. The accelerometer offset and level-mode qualification remain open.

## Validation

Host tests cover production task routing with the real rates, attitude and PID implementations; feedback signs/units; Angle behavior; failsafe precedence; invalid selection and unsafe-state guards; unchanged estimator-health disarming; measured PID integration at dividers 1/2/4/8; and low-throttle/first-cycle resets. CLI tests cover framing, argument rejection, overflow/NUL recovery and RAM-only reboot state. A separate compile variant proves Acro selection is refused with flight enable defined. These are software regressions, not physical sensor/motor validation.

Safe bench checking: props off, flight enable OFF, no motor test active; query/switch/query the mode, then explicitly return to Angle. No configurator mode-switch integration or AUX reassignment is included. Keep this patch separate from the pending Ports/Modes preview and accelerometer work.
