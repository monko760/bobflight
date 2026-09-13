# TMOTORF7V2 — USB / MPU6000 sensor bring-up

This is an **experimental sensor-only target**, not a flight release or a complete board port. Target: `tmotor_f7_v2`, STM32F722RE-class 512 KiB flash / 256 KiB RAM, MPU6000. Expected version: `0.2.0-prototype-tmotorf7v2-sensor1`.

The purpose is to compare stationary accelerometer readings with the Kakute, not to enable flight. Do not use this firmware to fly. Motor DMA binding is unavailable on this target; arming remains disabled. ADC battery/current readings, F722 nonvolatile configuration saving, blackbox, GPS, OSD and other peripherals are not implemented/qualified here. `save` cannot make this diagnostic target persistent. This is a temporary limitation, not the intended end state for normal configuration. Calibration remains RAM-only.

## Evidence and boundaries

Betaflight 4.4.0 readback identifies `manufacturer_id: TMTR`, `board_name: TMOTORF7V2`; STATUS identifies F722 and MPU6000 gyro/accelerometer. Fourteen target pin assignments matched its resource output. Pin facts are independently represented in the YAML, with a pinned upstream reference; no Betaflight implementation is copied. Other similarly named T-Motor boards are NOT interchangeable.

IMU SPI1 uses PA5/PA6/PA7, PA4 CS and PC4 interrupt resource. This driver polls MPU DATA_RDY; it does not implement gyro DMA or enable EXTI interrupts. LED is PC14. RX is fixed to UART2 PA2/PA3, CRSF, but is not needed for this test. First four connector resources are PB0/PB1/PB4/PB5; their motor backend remains disabled. ADC resources are PC2 voltage / PC3 current, NOT Kakute's reversed mapping.

The build uses nominal 8 MHz HSE and a conservative 168 MHz core / 48 MHz USB PLL path. Betaflight's 216 MHz STATUS is core speed, not crystal frequency. HSE has not been physically measured. The MCU family and 512 KiB flash-size registers are checked before normal peripheral access; this does not identify an entire board or replace recovery preparation. Only MPU6000 WHO_AM_I=0x68 is accepted.

**Aircraft settings are separate from target defaults.** Board mounting yaw, custom motor reordering, receiver map, PID tuning and failsafe policy are not imported from a particular quad. Never apply a 10-inch aircraft's 180-degree mounting rotation to every TMOTORF7V2. This image reports nominal board-frame orientation; use board axes, not an assumed mounted aircraft heading. Betaflight calibration numbers and PID values are not BobFlight-compatible coefficients.

## 1. Preserve a recovery path first

Remove all propellers and disconnect the flight battery. Use USB only. Save this board's Betaflight `version`, `resource` and `diff all` to your PC, and retain a way to reinstall the correct TMOTORF7V2 Betaflight firmware/configuration. A diff depends on the matching Betaflight target/defaults; it is not a full firmware image or a universal restore script. Do not run it in BobFlight. Do not overwrite the only recovery copy.

Confirm the board's BOOT button/pads and ST ROM DFU procedure before flashing. No script here flashes hardware. Keep the Kakute's firmware and files separate.

## 2. Get the source without disturbing other work

From Windows PowerShell, after the branch has been published:

```powershell
cd "C:\Users\Monko\BF ChatGPt"
git fetch origin
if ($LASTEXITCODE -ne 0) { throw "Fetch failed" }
git worktree add --detach "C:\Users\Monko\BobFlight-TMotor-Sensors" origin/feat/tmotorf7v2-bench-target
if ($LASTEXITCODE -ne 0) { throw "Worktree creation failed; do not overwrite an existing folder" }
cd "C:\Users\Monko\BobFlight-TMotor-Sensors"
git rev-parse HEAD
powershell -ExecutionPolicy Bypass -File .\build-tmotorf7v2-sensors.ps1
if ($LASTEXITCODE -ne 0) { throw "Build failed; do not flash a stale image" }
```

This does not switch, stash, reset or overwrite the existing repo and its other-agent changes. If the destination already exists, stop and inspect it; do not delete it or force the command.

The script uses the existing CMake/ARM toolchain under `%USERPROFILE%\BF ChatGPt\tools` or PATH, plus `mingw32-make.exe` (existing TDM-GCC). CMake must also find Python 3 for code generation and image checks. All flight, relaxed-calibration, reset-only and blocking LED diagnostic flags are explicitly OFF. It rejects incompatible cached targets. No `npm install` is required for this firmware-only change.

Expected checkpoint: compilation/link succeeds, `PASS TMOTORF7V2 HEX` verifies file checksums, program-memory bounds, initial stack/reset vectors and target/version markers, then a SHA-256 is printed. Output:

`C:\Users\Monko\BobFlight-TMotor-Sensors\bobflight-tmotorf7v2-sensors-bench.hex`

**Stop here and review the build output/hash before the first flash.** A syntax-only or host test is not an F722 link test, and an image check is not proof of correct hardware behavior.

## 3. First installation (after successful build checkpoint)

Use the current BobFlight Configurator's existing flasher, select **T-Motor F7 V2 / tmotor_f7_v2**, not Kakute. The configurator already has the F722/512 KiB flasher profile. Select only the newly built sensor HEX; keep demo mode OFF. Close any Betaflight serial connection. With battery disconnected and props removed, enter ROM DFU using BOOT while plugging in USB, then request the STM32 BOOTLOADER device and flash using the sector-erase/readback-verify path.

Require actual readback verification success. On any erase/program/readback error, stop; do not treat a progress bar or LED flash as success. Unplug USB and reconnect without BOOT. Open the normal serial connection; a new COM device may appear because this target uses the F722 UID address. Do not run motor tests, bench_switch, or import any aircraft configuration.

## 4. Collect raw sensor evidence before calibration

Hold the board still at startup. In BobFlight CLI run these separately:

```text
version
status
sensors
calibration
timing
storage
```

Expected: exact new version; board `tmotor_f7_v2`; MCU STM32F722; bench-only/disarmed; motors inactive/unavailable; sensor_config_ok=yes; increasing sample_seq; gyro_ok=yes and fresh sensor_age_ms (normally under 50 ms while actively sampling). `cal_bench_relaxed` must be no, accel_calibrated initially no, and raw/reported accel should match before correction. Gyro calibration is independent of accelerometer qualification. `storage` should honestly report unsupported rather than a verified flash save. An unavailable battery reading is expected, not a reason to connect the flight battery.

Before applying accelerometer calibration, collect **three `sensors` snapshots a few seconds apart in each stationary pose**: flat, upside down, and one side. Label the poses. Give the board several seconds to settle after each move. Keep the startup `calibration` and `timing` output; repeat timing at the end. Do not change offsets, gains, sensor alignment or calibration policy to make the result look right.

For a stationary accelerometer, magnitude `sqrt(x*x+y*y+z*z)` should be around 1 g, with the dominant axis changing sign for opposite poses. Magnitudes outside the existing 0.9–1.1 g screening range, large off-axis readings, or inconsistent repetitions are diagnostic findings: preserve them and stop changing calibration settings. Near-1 g alone does not establish precise calibration, healthy mounting, or flight readiness. No battery, motor power or PID tuning is necessary for this comparison.

## Stop / recover

Stop if USB repeatedly resets, the version/board/MCU is wrong, sensor data freezes or ages beyond 50 ms repeatedly, sensor_config_ok is no, any motor becomes active, the board heats unexpectedly, or gravity readings are inconsistent. Keep the exact error/status and timing data; don't increase power or weaken guards.

If normal USB does not enumerate, disconnect USB, enter ST ROM DFU again with BOOT, and restore the known-compatible Betaflight TMOTORF7V2 firmware using its standard flasher. Restore the saved diff only after checking the matching target/version; verify it with props removed. Do not guess BOOT pads or substitute an H7/Kakute image. If ROM DFU is unavailable, stop and investigate the cable/port/boot procedure rather than flashing a different target.

## Validation scope

Local host regression and ARM syntax checks are software evidence only. F722 image linking and flashing are performed on the owner's PC with the above script. The target is not marked hardware-verified. Scheduler/PID/arming/failsafe implementations remain unchanged; the target cannot be configured with flight or relaxed accelerometer calibration ON. Nonvolatile configuration support and powered motor validation require separate, reviewed work before a complete target can be claimed.

### Recorded software checks for this source increment

- 44/44 host tests passed on each of dummy, Kakute F7 HDV and TMOTORF7V2 selections. New tests exercise the actual SPI map, generated target loader, configuration refusal, synthetic HEX validation and real F7 HAL motor/ADC/unsupported-flash entry points. These are not physical SPI, USB or DMA tests.
- F722 cross-configuration succeeded with the intended toolchain/linker and all diagnostic/flight flags OFF. ARM syntax checks passed for the changed C files. No F722 firmware ELF/HEX was built remotely; the complete link/image check is the owner's local build checkpoint. The PowerShell script has not been executed on Windows here.
- Review prompted explicit `.dma` placement in DMA-accessible SRAM and a DTCM data/stack layout with word-aligned startup sections and 8 KiB stack headroom enforced at link time. The former AXI stack top was not inherently invalid; placing the stack in DTCM is deliberate, not evidence that AXI stacks cannot work. No config-slot symbols were added: F722 flash persistence is intentionally unsupported, so importing F745 reservation addresses would be wrong.
- No changes to scheduler, PID, attitude, failsafe or arming implementations. Hardware qualification and a complete target remain open.
