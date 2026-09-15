# Props-off closed-loop development profile

This increment makes armed control possible **for development only**, behind an explicit build profile. The default bench build is unchanged and still cannot arm. **Nothing here is flight qualification, and props must be off.**

## What changed

- **Acro is gyro-only.** Arming readiness is mode-aware: an Acro request requires calibrated, healthy, live gyro data only (`gyro_rate_ready`). It no longer requires a qualified accelerometer, attitude readiness or the 20-degree tilt check. Angle/Horizon keep every existing requirement, including the 0.9–1.1 g gravity gate.
- **Flight profile routing.** In `BOBFLIGHT_FLIGHT_ENABLE=1` builds, manual Angle and Acro can be selected (`control_mode angle|acro`). Horizon is refused — its blended leveling needs a qualified accelerometer. AUX-source mode routing stays disabled in this profile; the ARM range switch is independent and remains active. Staged HOLD/LAND failsafe output is leveling-based: if gravity is unqualified it **fails closed (disarms)** instead of pretending to level. Angle cannot arm with an unqualified accelerometer.
- **Bench build unchanged.** All of this is behind the flight-enable define. The standard bench image keeps its lockout, its AUX1 8% switch bench session, and identical behavior (83 host tests unchanged).

## Build (Kakute F7 HDV only)

`build-closed-loop-development.ps1` builds the opt-in image. It requires explicit `-PropsRemoved -AcknowledgeUnqualifiedFirmware` switches, sets `BOBFLIGHT_FLIGHT_ENABLE=ON` with relaxed calibration OFF, uses a separate build directory and HEX name, and never flashes. TMOTORF7V2 has no motor backend and remains locked out by CMake.

The dev image refuses the fixed-percentage bench switch session (`bench: flight-build-refused`); use the bench image for that test. `status` reports `flight_mode: closed-loop-development`; the bench image still reports `bench-only`.

## Props-off test sequence (board on bench, props removed, motor wires connected)

1. Flash the dev HEX; confirm `status`: disarmed, `flight_mode: closed-loop-development`, receiver fresh, `timing` healthy.
2. `control_mode acro`, then verify `modes`: requested/effective `acro`. The ARM range must still be enabled (default AUX1 1751–2100).
3. Arm low, raise throttle slowly: motors spin and respond to frame rotation with corrective differential output. Set the frame down level and still: outputs settle toward the throttle-commanded baseline (integral retention can hold a small differential; that is not itself a fault — the blackbox capture will show why).
4. Every existing guard still applies: low-throttle-only arming, fresh receiver, gyro health, timing window, failsafe. Disarm: flip the ARM switch out of range, or drop throttle below 5%.

## Stop conditions and scope

Stop and return to the bench image on unexpected output, wrong target, lost configuration, or unreliable USB. This profile does not validate accelerometer qualification, Angle/Horizon leveling, or any flight-readiness claim. The RAM blackbox capture (in development) is the diagnostic tool for tuning; motor commands are DShot output values, not measured RPM.
