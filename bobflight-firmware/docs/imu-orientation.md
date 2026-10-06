# Board-defined IMU quarter turns

This follow-up builds on target foundation PR #68, now merged into main. This follow-up remains a separate review; it is not automatically merged. This is a sensor-data correctness change, not new motor support, an MCU port, or flight qualification.

## Supported physical mappings

The board IR `gyro_align` field now selects the same sensor-to-body mapping for gyro and accelerometer samples:

| Definition | Body X | Body Y | Body Z |
| --- | --- | --- | --- |
| `CW0_DEG` | sensor X | sensor Y | sensor Z |
| `CW90_DEG` | sensor Y | -sensor X | sensor Z |
| `CW180_DEG` | -sensor X | -sensor Y | sensor Z |
| `CW270_DEG` | -sensor Y | sensor X | sensor Z |

The historical CW270 mapping is unchanged. CW90 and CW180 previously fell through to identity; they are now actually applied. These are proper Z-axis quarter turns, not flipped mounting or arbitrary Euler rotations. Unsupported, empty, duplicated or missing physical alignment fields fail validation rather than silently choosing identity. Stub/draft IR without a mounting field retains a host-only identity default. Existing host-only sensor fixtures may omit the field; physical driver initialization rejects an empty field.

Mounting is compiled board configuration, not a live aircraft setting. Resolve it once during driver initialization, then use bounded swaps/sign changes during sampling. A definition change requires regeneration and driver reinitialization. Cached repeated MPU6000 samples are already in body axes and are not transformed twice. No scheduler, PID cadence, arming/failsafe policy or configuration storage layout is changed.

## Persisted calibration compatibility

Existing CW0/CW270 calibrations retain their exact binding and correction model. Newly implemented CW90/CW180 use correction-model revision 2 inside the existing binding hash. The loader recognizes old model-1 calibration only when the detected sensor ID, range, configured SPI resources and coefficient validation still match. It discards those obsolete coefficients in the RAM copy and restores the other validated aircraft settings. It does not reinterpret the old coefficients or write flash during loading.

Status reports `migrated_accel_orientation` and dirty settings until explicit `save`; combined legacy control-source migration is reported as `migrated_control_source_manual_accel_orientation`. The warning repeats after reboot until saved. Affected accelerometer calibration is marked invalid and must be redone before relying on corrected attitude data. Save writes the normal existing record format without obsolete calibration. No NVM layout change, automatic erase, gyro-calibrated flag, flight-ready flag or fabricated calibration session is introduced.

Unknown sensor/binding mismatches, malformed calibration flags, non-finite/invalid coefficients, and invalid unrelated settings still reject the record. This is a narrowly identified migration, not a blanket bypass of record validation.

## Bounded validation

Tests cover 12 independent basis-vector mappings, norm and four-turn cycle preservation, invalid inputs, real gyro-driver MPU6000 register fixtures under both host and physical compile paths, aligned gyro/accel/raw-diagnostic agreement, cached sample freshness, initialization-only mapping, old-versus-new calibration bindings and seven IR regression cases. Persistence regressions verify cold reload, unchanged aircraft-setting bytes, no automatic flash writes, explicit save, seven corruption cases, and combined legacy control-source migration. The full native regression suite covers existing control timing, persistence, failsafe and logging paths. F722 image checks validate build format/vectors/bounds, not physical execution. No hardware latency measurement or physical `bl` validation is claimed.

## Optional source-only Windows review

No firmware installation is requested. The repository's existing ARM/CMake/MinGW/Python requirements still apply. These commands preserve the original working tree and never flash a controller:

```powershell
Set-Location 'C:\Users\Monko\BF ChatGPt'
git fetch origin
if ($LASTEXITCODE -ne 0) { throw 'Fetch failed' }
git worktree add '..\bobflight-imu-orientation' origin/feat/board-imu-orientation
if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed; do not overwrite an existing folder' }
Set-Location '..\bobflight-imu-orientation'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-target.ps1 -Target tmotor_f7_v2
if ($LASTEXITCODE -ne 0) { throw 'Build failed. Do not use an older artifact.' }
```

Expected source result: registry validation, successful source build and verified HEX/manifest paths. This remains the existing sensor-only F722 target, without motor output or SD logging. No board definition was changed by this PR.

## Physical-test restrictions and future acceptance

Robert's TMOTORF7V2 physical BOOT button is broken. Do not install this experimental build until an independent recovery route is established. Software `bl` depends on functioning startup and USB and is not an independent recovery path.

A separately authorized test on matching hardware with working recovery would require a `diff all` backup, preserved logs, propellers removed, disarmed outputs and inactive motor tests/calibration before installation. Verify `version`, `status`, sensor identity, gyro and accelerometer axis directions under known movements, retained aircraft settings, required recalibration and nonvolatile `save`. Verify software `bl` on that hardware before relying on it. Stop on wrong identity, wrong axes, lost settings, unhealthy sensors or USB/reset failures. Recovery must use the independently verified route and a known matching image/configuration, not an assumed working BOOT button. This source PR does not authorize physical installation or a hover test.
