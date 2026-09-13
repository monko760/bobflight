# MCU firmware plus validated board profiles — architectural direction

**Accepted direction, not a claim of shipped unified targets.** Current images still select `BOBFLIGHT_BOARD` at build time. F745 Holybro and F722 T-Motor remain the current hardware targets; H7 bring-up is not part of the calibration-persistence increment.

## Three distinct configuration layers

1. **MCU build/manifest:** exact supported part/variant, flash and RAM layout, startup/vector table, clock capabilities, ROM recovery, peripheral/DMA inventory and implemented HAL backends. Build labels should distinguish F722, F745, H743, H723, etc. “H7” is not one interchangeable executable. Flash density/package/peripheral differences may require finer variants.
2. **Board hardware profile:** board identity/revision and compatible MCU manifest, oscillator/USB setup, physical sensor identities/buses/CS/interrupts/alignment, motor connector-to-timer/DMA resources, UART/pins, LED/ADC resources and storage capability. No arbitrary unvalidated register programming. Validate resource ownership, alternate functions, DMA/timer conflicts, counts and driver availability before enabling anything.
3. **Aircraft/user configuration:** PID/rates, receiver selection/map, modes, mixer and aircraft-specific rotation/motor order, plus sensor-bound calibration. The owner's 10-inch aircraft yaw180 and motor reordering are NOT defaults for a generic T-Motor board.

Desired workflow: choose an exact MCU firmware, select/apply an individual board profile separately, then configure the aircraft. Reusing the same core image across compatible boards is the goal. A profile cannot supply missing compiled drivers or make a physically different MCU binary compatible.

## Bootstrap is part of the design

Current USB initialization depends on board oscillator settings before the normal CLI exists. Therefore “flash generic firmware, then enter clock/pin settings over USB” cannot be assumed to work on an unknown board. Do not claim that an arbitrary HSI fallback provides compliant USB on every F7/H7.

The future configurator should be able to provision a validated board profile through ROM DFU **after core flashing but before the first normal boot**, or use an explicitly verified MCU/bootstrap preset on variants that support it. The exact profile region comes from the MCU firmware manifest/linker layout, not a guessed common address. A profile loader must run before profile-dependent clocks and peripheral initialization. Preserve a recovery route independent of normal application USB.

Missing, mismatched or corrupt profiles must leave motor/resource initialization disabled and expose only a proven recovery/diagnostic path. Unknown hardware must not borrow Holybro pins or default to flight-enabled behavior. Profile updates require disarmed/inactive outputs, full validation, transactional storage, verified readback and a controlled restart.

## Foundations included in the current persistence patch

The generic record store now asks the HAL for two disjoint erase-region offsets/sizes and a programming granule. The F745-specific addresses remain inside its backend; unsupported backends return unsupported. Schema2 writes its final commit marker in a separate aligned 32-byte region, avoiding reprogramming the header's programming/ECC word. Simulated tests cover alternate slot layouts and 1/2/4/8/16/32-byte program granules. Wider/invalid geometry is refused, not silently supported.

Actual H7/F722 backend ports still require exact linker reservations and hardware-specific cache, ECC, erase, program, voltage and watchdog validation. Simulation of a 32-byte granule is NOT H7 hardware support.

Calibration is bound to board identity, correction-model version, detected IMU ID, range, alignment and sensor bus/CS resources. A future profile loader should extend/version that binding with the validated profile/sensor identity digest so changing a profile cannot silently reuse inappropriate calibration. Applied calibration and user settings remain separate from early-boot board-profile storage.

## Staged implementation after persistence acceptance

- Define a versioned MCU manifest and board-profile schema/validator while retaining present per-board builds and defaults. Test missing/foreign/corrupt/conflicting profiles with zero peripheral side effects.
- Separate early profile loading from aircraft-config restoration; replace board-name checks and generated-pin dependencies with validated MCU capability/resource dispatch one subsystem at a time.
- Prove MCU-image reuse across known boards, provisioning/recovery and rejection behavior on the bench before adding more MCU variants and sensor/storage drivers.

Do not enlarge the current firmware-image flash range or weaken the existing MCU gate merely to load profiles. Profile provisioning needs its own bounded, explicitly validated operation. No change here authorizes arming, removes flight restrictions, or substitutes open-loop motor tests for PID stabilization verification.
