# Persistent accelerometer calibration — bench acceptance

## Scope and current support

This increment adds explicit `save` and startup restoration of validated, **applied** accelerometer bias/scale. Existing PID/rates, RX UART/map, all four mode rows, and manual/AUX mode selection remain included. There is no automatic save after Apply. Gyro startup bias, raw samples, incomplete/candidate solutions, power and DShot settings are NOT stored. Strict six-face validation and all arming/flight restrictions remain unchanged.

- **Holybro Kakute F7 HDV / F745:** existing qualified-address flash backend is used. Expected version `0.2.0-prototype-switchbench2-bl1-calstore1`.
- **T-Motor F7 V2 / F722:** shared protocol/schema support, but the actual hardware storage backend is still unsupported. Version `0.2.0-prototype-tmotorf7v2-sensor2-bl1-calstore1` does NOT mean F722 flash or motors are implemented. Do not reflash it merely for this Holybro acceptance.
- Other targets are not enabled by this change. Shared storage now obtains slot offsets/sizes and programming granularity from the HAL, not a hardcoded F745 stride. See [unified-target design](bobflight-firmware/docs/UNIFIED-TARGETS.md).

## Record, migration and failure behavior

Schema 2 retains configuration bytes 0–95. Byte 96 indicates applied calibration; bytes 97–99 are zero; bytes 100–103 bind the correction model, detected sensor, configured range/alignment and sensor bus/CS resources; bytes 104–115 contain three LE binary32 biases and 116–127 three scales. Records remain board-ID-bound and CRC checked. Changing the sensor binding rejects restoration before any setting is mutated. No stored gyro-ready/arming/session flag is trusted. Gyro startup calibration still runs.

A 32-byte header and 128-byte payload are physically written/read back first. A **separate aligned 32-byte commit block** follows; schema-2 never programs the header's legacy seal word twice. This supports backends with 1/2/4/8/16/32-byte programming granules without pretending an H7 backend is already implemented. Unsupported geometry fails closed. A backend must reserve two independent erase regions outside firmware and correctly handle hardware ECC, caches, program/erase constraints and watchdogs.

Existing schema-1/96-byte settings load with **no invented accelerometer calibration** and a dirty/migration indication. Explicit save writes the alternate slot first; the original slot is not erased first. No-change saves avoid additional erase cycles. Corrupt records can fall back to another valid record; foreign/future formats are not silently overwritten. Some malformed/interrupted headers may require deliberate recovery instead of another automatic save. Never force erase as a troubleshooting reflex.

`calibration_storage` distinguishes `not-calibrated`, `unsaved`, `flash-verified`, `host-sim`, `ram-only`, and `error`. `flash-verified` means verified stored coefficients, not flight qualification. Other settings can still be dirty. A reported save failure is not success; collect `storage` and `calibration` before further action.

## Local Windows update — no remote HEX

Keep the existing repo and local edits. Fetch source into a **new worktree**, pinned to the reviewed PR commit. From `C:\Users\Monko\BF ChatGPt`, run `git status --short`, then `git fetch origin feat/persistent-accel-calibration`. Print `git rev-parse FETCH_HEAD` and verify it equals the reviewed commit supplied with the PR. Use `git worktree add --detach C:\Users\Monko\BobFlight-Cal-Persistence <that-exact-commit>`; replace the bracketed value with the reviewed hash. If the destination exists, inspect it and stop rather than delete/force it. Do not stash/reset/rebase other work.

In the new worktree, print `git rev-parse HEAD` and ensure `git status --short` is empty. Build **on the owner's PC**:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-bootloader-bench.ps1 -Board kakute_f7_hdv
```

The existing script selects F745, leaves flight/relaxed/reset/LED diagnostic flags OFF, checks compiler/cache identity, validates image bounds/vectors/version and prints SHA256. Output: `bobflight-kakute_f7_hdv-bootloader-bench.hex`. **STOP and review the final build output/hash before flashing.** PowerShell execution and an MCU link are not claimed verified by host tests.

Matching configurator, from the same worktree:

```powershell
cd bobflight-configurator
npm.cmd ci
npm.cmd run typecheck
npm.cmd --prefix protocol run test:sensors
npm.cmd --prefix protocol run test:bootloader
npm.cmd run build
npm.cmd run dev
```

Run one command at a time and stop on failure. Use the URL Vite actually prints. Stop the previous Vite server so an old client is not mistaken for the new one. No builder or remote HEX download is required.

## Before flashing

Props removed, flight battery disconnected, USB only. Stop all motor bench/AUX sessions and calibration sessions. Verify the actual attached controller is Holybro, and select **Kakute F7 HDV / F745**, not T-Motor/F722. Keep an independent working physical bootloader/recovery path; software `bl` cannot rescue failed startup.

On the currently working firmware, keep local copies of `version`, `status`, `storage`, `diff all`, `dump all`, and `calibration`. Do not request an unavailable old Betaflight backup. Save any desired supported changes before `bl`; use `bl discard` only when you deliberately accept discarding unsaved RAM values. Verify actual STM32 ROM DFU, not merely USB disappearance. Follow [BOOTLOADER.md](BOOTLOADER.md) for safety and DFU checks.

Use addressed-image flashing/readback verification; **do not mass erase** or erase reserved settings sectors. The image validator excludes data at/above `0x08080000`. Any tool that erases all flash defeats preservation regardless of HEX bounds. Stop for target mismatch, uncertain erase behavior, failed verification or unstable DFU.

## First boot and six-face calibration

Reconnect normally and collect `version`, `status`, `storage`, `calibration`, `sensors`. Expect the exact Holybro version above, schema 2, backend `flash`, bench-only/disarmed, motors inactive, healthy/fresh supported IMU. Previous configuration should be restored; schema-1 migration may initially be dirty. An uncalibrated record must NOT become `accel_calibrated: yes` by migration.

Use the Sensors page with props-off/stationary acknowledgments. Capture each of +X, -X, +Y, -Y, +Z, -Z using the **reported raw axes**, not an assumed airframe front. Let each stationary window finish; green captured cards alone are not calibration. Press Apply only after all six faces are captured. If Apply rejects, retain diagnostics and recapture the indicated poses; do not relax limits or manually overwrite coefficients.

Successful strict Apply should report `accel_calibrated: yes`, raw readings unchanged, and `calibration_storage: unsaved`. Switch to CLI after Apply (not during capture), run individually:

```text
calibration
storage
diff all
save
storage
calibration
```

Require exact reply `saved: flash verified`, storage `state: saved`, `dirty: 0`, and calibration `flash-verified`. Record the coefficient vectors and configuration. A large-offset warning remains meaningful even when storage succeeds.

## Actual power-loss acceptance — required before calling persistence complete

Disconnect **all power** (including USB); wait, reconnect normally, and leave stationary for startup gyro calibration. Do not Apply calibration again before reading it back. Run `version`, `storage`, `calibration`, `sensors`, `diff all` individually.

Require the same saved accelerometer coefficients (within printed precision), `accel_calibrated: yes`, `calibration_storage: flash-verified`, and restored pre-existing settings. Gyro calibration must run anew; face-capture masks/candidates must not be fabricated. Confirm corrected acceleration near 1 g with the correct signed dominant axis on all six faces, fresh samples, raw telemetry retained, and inactive motors. Repeat a second complete power cycle. Also verify guarded `bl` entry and normal restart retain saved calibration; unsaved changes must still be refused without explicit discard.

No motor/arming/hover test is authorized by this procedure. Zero-output PID diagnostic implementation and timing acceptance are later increments.

## Export and recovery limits

`diff all` and `dump all` include accelerometer numbers as **diagnostic comment metadata**, not replayable commands. Pasting an export does NOT reinstate accelerometer qualification after flash is erased; redo six-face calibration in that case. There is no unsafe coefficient-import command in this increment.

Stop on changed/lost coefficients, unexpected defaults/dirty/errors, sensor-binding rejection, active motors, failed save/readback, unhealthy/stale sensor data, or no normal USB after restart. Preserve logs and exports; do not repeatedly save, mass erase or relax safety gates. Recover through verified ROM DFU using a known matching image. Older firmware cannot fully interpret schema 2 and may expose only an older surviving schema-1 slot; do not assume downgrade retains the newest settings. Review the recovery plan before deliberately overwriting configuration.
