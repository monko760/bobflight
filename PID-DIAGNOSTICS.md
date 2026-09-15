# Zero-output rate/PID diagnostics — freshness fix

> **Current Kakute workflow:** [One main build: flash, configure, props-off PID check](MAIN-BUILD.md). Use `build-main.ps1` and `bobflight-kakute_f7_hdv-main.hex`. Any bench/development profile commands below are historical and retired; normal runtime guards still apply.

This is a RAM-only Acro/rate shadow PID. Its correction never enters the motor mixer or motor drivers. It does not arm, stabilize a craft or establish flight readiness. Production PID equations, gyro driver/filter, scheduler, arming, failsafe, persistence and bootloader implementation are unchanged. Accelerometer qualification and Angle/Horizon diagnostics are separate work; six-face calibration is not required for this gyro-only check.

## What changes in piddiag2

A short MPU6000 DATA_RDY wait can return the last still-recent hardware sample without advancing its sensor sequence. Previously that reset the entire diagnostic PID history. Now:

- A duplicate sample produces `active: yes`, `valid: no`, `reason: waiting-new-sample`, zero public vectors/dt, and `sample_age_us: -1`. It increments `waits`, NOT `resets`, and does not advance the computed `sample_seq` or computation timestamp.
- Private integrator/derivative state survives a bounded wait. The next genuinely fresh sample uses the elapsed time since the previous computation: a one-slot wait at 1kHz normally gives about 2000us, not 1000us.
- Zero/backwards time, elapsed computation time >=20000us, stale input, nonfinite values and existing safety guards still clear/reset or stop diagnostics. Waiting/priming does not evade producer-stall checks. The session still expires after 60 seconds and never auto-restarts.

Telemetry stays API1 with the same CLI commands and terminator. Additive fields are `waits`, `last_reset_reason`, `reset_dt_invalid`, `reset_gyro_stale`, `reset_guard`, `reset_other`. Reasons persist after recovery until another actual reset or a successful new start. `reset_gyro_stale` includes producer/diagnostic staleness; `reset_other` includes nonfinite/config faults, explicit stop and session expiry. `resets` remains total resets, not board reboots. A successful NEW start clears session counters. Rate/error vectors use six significant digits (possibly exponent notation) to keep even large finite values inside the existing 1024-byte CLI response buffer. Correction remains six-decimal text, not a motor percentage.

No change to existing `save`/nonvolatile PID, rates or configuration storage. F722 flash storage support is not added. Diagnostic sessions/counters/history remain RAM-only.

## Owner-PC build — preserve the old worktree/cache

Use the reviewed `fix/pid-diagnostic-freshness` PR head, or main after that PR merges. The existing PR30 configurator accepts these additive CLI fields; no production frontend change is required for this firmware fix. Do not force-reset, erase a build cache or bypass compiler checks.

Run in PowerShell. This creates a separate worktree without disturbing edits in the original repository and uses its existing compiler tools. Stop if the destination already exists.

```powershell
$ErrorActionPreference = "Stop"
Set-Location "C:\Users\Monko\BF ChatGPt"
git fetch origin fix/pid-diagnostic-freshness
if ($LASTEXITCODE -ne 0) { throw "Fetch failed." }
$clean = "C:\Users\Monko\BF PID Freshness"
if (Test-Path -LiteralPath $clean) { throw "Destination exists; preserve it and stop." }
git worktree add --detach $clean origin/fix/pid-diagnostic-freshness
if ($LASTEXITCODE -ne 0) { throw "Worktree creation failed." }
Set-Location $clean
git log -1 --oneline
```

Check that revision against the reviewed PR head before continuing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-bootloader-bench.ps1 -Board kakute_f7_hdv
if ($LASTEXITCODE -ne 0) { throw "Build failed. Do not use an older HEX." }
Get-FileHash -Algorithm SHA256 -LiteralPath ".\bobflight-kakute_f7_hdv-bootloader-bench.hex"
```

Require successful image bounds/version validation and matching source/copied-file SHA256. Expected Holybro version: `0.2.0-prototype-switchbench2-bl1-calstore1-piddiag2`. Expected file: `C:\Users\Monko\BF PID Freshness\bobflight-kakute_f7_hdv-bootloader-bench.hex`. The script never flashes. Flight enable and relaxed acceleration stay OFF. A source test pass is not an installed or independently validated MCU image.

## Install and preserve configuration

Props removed, flight battery disconnected, USB only. Keep `version`, `status`, `storage`, `diff all` and `dump all` locally. The previous physical report showed `dirty: 1`: inspect the current settings before doing anything that loses RAM. Use `save` ONLY if they are the settings intended to keep; require successful readback (`dirty: 0`, no error). Do not use `bl discard` merely to bypass this decision. Do not import a Betaflight dump into BobFlight.

Follow `BOOTLOADER.md`: stopped diagnostics, disarmed, no motor bench/calibration activity, then guarded `bl`. Confirm actual STM32 DFU recognition, not just serial disconnect. Flash only the validated target-specific HEX without mass erase and require programmer completion/verification. Reconnect normally; verify exact piddiag2 version, target, restored settings and healthy calibrated gyro. Gyro bias is deliberately RAM-only; if needed, hold still for gyro calibration, not six-face capture. Independent ROM recovery remains necessary if firmware/USB cannot start.

## First check — only about ten seconds

Do this first; don't combine receiver, timeout, timing and DFU tests into one long sequence. Stay in the CLI.

1. `pid_diag start` — priming/invalid is normal initially.
2. Keep still for about 10 seconds; run `pid_diag` and retain the ENTIRE response.
3. `pid_diag stop` — before the 60-second expiry. Require inactive/invalid and cleared outputs.

The running response should normally show `valid: yes`, `source: zero`, `mode: acro`, `motor_output: disabled`, advancing computed sequence, fresh age, plausible positive dt, zero setpoints and near-zero gyro/error. `waits` may increase; **`resets` should remain zero with `last_reset_reason: none` during this simple healthy run**. A captured `waiting-new-sample` frame is explicitly invalid with cleared outputs; read one more snapshot rather than treating it as a fresh valid result. Intermittent 2ms dt is expected after one wait. Explicit stop then adds one reset and records its reason.

Keep an unexpected refusal, increasing resets, stale-valid/nonfinite output or failure to stop for inspection. Don't adjust gains, relax thresholds, add battery power, recalibrate the accelerometer or repeatedly flash to make the test pass.

## Separate follow-up checks

Once the short check passes, perform each as its own manageable checkpoint:

- **Movement and timing:** keep both complete `timing` reports from the SAME boot. Take baseline, start a bounded session, read a snapshot while gently rotating one axis, stop BEFORE timeout, then take the second timing report. Error equals demand minus measured rate; I/D history means instantaneous correction sign is not always opposite one sample. Compare delta skips/overruns; cumulative maxima are not timing distributions or evidence of causation. Do not poll other live tabs during this comparison.
- **Timeout and disconnect:** separately start/wait65s/read to confirm expiry; then start another session and unplug/reconnect USB to confirm no automatic restart. Configuration must be intentionally saved first. A stop response AFTER expiry does not prove interruption of an active session.
- **Receiver and bootloader:** RX is OPTIONAL and only if the receiver can be powered without flight battery/ESC power. With fresh mapped channels/throttle low, `pid_diag start rx` reports existing configured rates; loss must invalidate/reset and never present stale demand as live. After diagnostics stop, separately verify guarded `bl` enters actual STM32 DFU and return to normal firmware without reflashing, confirming version, inactive diagnostics and saved settings.

Never use arming, `bench_switch`, motor pulses or `motor_test` as part of this acceptance. Mutual exclusion is covered in native regression, not by intentionally driving motors during this test.

## Stop and recovery

Stop for unexpected motor activity, wrong target/version, lost configuration, stale/nonfinite valid data, failure to stop/expire, new USB faults or worsening timing. Disconnect power immediately for unintended motor activity. Preserve command responses/programmer logs. Do not increase outputs, force erase or repeatedly reflash. If firmware USB cannot start, use established independent ROM recovery and the last known-good target-specific image. No flight acceptance is claimed.

## Source validation

The native real-MPU6000-driver regression uses deterministic fake SPI/time, not real hardware. Across 5000 scheduler attempts with 50 DATA_RDY waits, piddiag1 reproduces 50 resets; this version requires 4949 fresh computations, 50 waits and zero spurious resets. It compares independent PID outputs with the unchanged original equation/state integration across waits and checks active stop. Actual serialized priming/running/waiting/resumed/stopped responses are consumed byte-by-byte by the configurator's real response collector. Other regressions cover exact timestep boundaries, repeated waits, stale producer during waiting/priming, wrap, safety guards, nonfinite values, retained reset causes, original-state isolation, unchanged configuration and bounded responses.

Software checks do not measure physical deadline jitter or explain every reset in the original device log. Use the PR's final validation record for completed commands/results and CI state; MCU compilation and the physical short check remain owner-PC tasks.


### Local validation record — September 13, 2026

Parent-verified 51/51 native tests on each of `dummy`, `kakute_f7_hdv` and `tmotor_f7_v2` (153 passes), including the new real-driver regression. The same test compiled against immutable `piddiag1` reproduces 50resets; the patched source yields 0 spurious resets with 50waits/4949computations over5000attempts. Axes are 0/1/2=roll/pitch/yaw; loops use zero-based indexing.

All 19 configurator CI commands passed in a clean dependency installation, including both typechecks, PID/timing/bootloader/sensor/motor/mode regressions and the production build. Actual native firmware-to-configurator Ports/Modes, storage/export and expanded PID framing contracts passed. The five emitted real PID frames were 408, 424, 422, 425, 426 bytes, all below 1024; CR-only line termination is accepted by the existing collector when CRLF is split byte-by-byte.

The bounded independent review identified waiting/priming producer-stall coverage and fixed-point telemetry-size risks. Parent added the stale-history guard for all primed states, bounded rate/error formatting and regressions. Zero elapsed on a duplicate is deliberately treated as invalid timing, consistent with the existing strict timestep policy; the diagnostic runs in the 1kHz task, not a free-running sub-microsecond poller. That conservative policy is explicitly tested.

Production source diff audit: only `pid_diag.c/h` changed. The object has no motor-write, mixer-write, arming-write, production-PID or persistence-save reference. Original PID, isolatedcore wrapper, gyro/filter, tasks/scheduler, arming, failsafe, flash/persistence and bootloader sources are byte-for-byte unchanged. MCU image construction/installation and physical timing, short-check, RX, disconnect and DFU recovery on `piddiag2` are NOT established by these native tests. Existing GitHub CI runs independently; check its current result before installation.
