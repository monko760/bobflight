# Zero-output rate/PID diagnostics — bench increment

This adds an explicitly started, RAM-only **Acro/rate shadow PID**. It reports requested rates, measured gyro rates, error and computed correction. Its output never feeds the motor mixer or motor drivers. It does not arm, provide stabilization or make a board flight-ready. Angle/Horizon diagnostics and flat accelerometer calibration are separate work; neither is required for this increment.

The existing PID/rate configuration remains persistent through the existing `save` mechanism on supported hardware. Diagnostic sessions, samples and integrator state are deliberately not persistent and never auto-restart. This patch does not expand F722 flash support.

## Source and local Windows build

Use the reviewed `feat/pid-diagnostics-zero-output` branch, or main after that PR is merged. Preserve local edits; do not force-reset or auto-stash.

From the existing repository, first inspect:

```powershell
Set-Location "C:\Users\Monko\BF ChatGPt"
git status --short
git branch --show-current
```

If clean, fetch and create an isolated local worktree (stop if the destination already exists):

```powershell
git fetch origin feat/pid-diagnostics-zero-output
if ($LASTEXITCODE -ne 0) { throw "Fetch failed." }
git worktree add --detach "..\BF PID Diagnostics" origin/feat/pid-diagnostics-zero-output
if ($LASTEXITCODE -ne 0) { throw "Worktree creation failed." }
Set-Location "C:\Users\Monko\BF PID Diagnostics"
git log -1 --oneline
powershell -NoProfile -ExecutionPolicy Bypass -File .\build-bootloader-bench.ps1 -Board kakute_f7_hdv
if ($LASTEXITCODE -ne 0) { throw "Build failed. Do not use an older HEX." }
```

Compare the source revision to the reviewed PR head. Require a successful image validator and matching copied-file SHA256. Expected Holybro version: `0.2.0-prototype-switchbench2-bl1-calstore1-piddiag1`. Expected HEX: `bobflight-kakute_f7_hdv-bootloader-bench.hex` in this new worktree. Flight enable and relaxed acceleration remain OFF. This script builds on the owner's PC; it never flashes a controller.

Then run each configurator command separately, stopping on the first failure:

```powershell
Set-Location "C:\Users\Monko\BF PID Diagnostics\bobflight-configurator"
npm.cmd ci
npm.cmd run typecheck
npm.cmd --prefix protocol run test:pid-diagnostics
npm.cmd --prefix protocol run test:timing
npm.cmd --prefix protocol run test:bootloader
npm.cmd run build
```

Do not use `npm audit fix --force`; dependency remediation is separate. Stop any old Vite instance. Serve only the built UI, not the affected Vite development server:

```powershell
python -m http.server 5173 --bind 127.0.0.1 --directory .\ui\dist
```

Open `http://127.0.0.1:5173` in Chrome/Edge. Leave that terminal running. Use a separate terminal for other commands. Stop and report a Python/port error rather than switching to an unreviewed server setup.

## Install

Remove every propeller. Disconnect the flight battery; use USB power only. Read `version`, `status`, `storage`; keep local `diff all` and `dump all` backups of the installed BobFlight configuration. Never restore a Betaflight dump into BobFlight.

Use the established `BOOTLOADER.md` procedure. Software `bl` requires functioning normal firmware/USB and refuses active calibration, armed/motor states and unsaved configuration. `bl discard` explicitly discards unsaved RAM settings; do not use it merely to bypass a refusal. Do not mass erase. Flash only the validated Holybro HEX; verify the programmer reports completion and verification. Reconnect normally and confirm the version above, board identity and restored settings. Independent ROM recovery must remain available; software BL cannot rescue firmware that fails to start.

## Test 1 — gyro only, no receiver required

Stay in the CLI; do not open other live polling tabs during the timing comparison. Confirm `status` is disarmed and no motor bench session is running. `sensors` must show a healthy, fresh, calibrated gyro. **Accelerometer calibration is not required.** If needed, cancel the old manual calibration with `calibration_cancel`, then run `calibrate_gyro` and keep the board still until `calibration` reports completion. Do not repeat six-face calibration for this test.

```text
timing
pid_diag start
pid_diag
```

The initial frame may be priming. Subsequent snapshots must identify `mode: acro`, `source: zero`, `active: yes`, `valid: yes` and `motor_output: disabled`, with advancing `sample_seq`, recent `sample_age_us` and a sensible measured `dt_us` near the 1 kHz loop interval. Zero source sets all requested rates to zero, not receiver input.

Gently rotate the board about one axis while reading another `pid_diag` snapshot. Compare the numeric axis rate with its error: error equals demand minus rate. From a fresh/reset session, positive gyro movement against zero demand should produce an opposing correction. Integral/derivative history and saturation mean the correction need not always have the opposite sign of one instantaneous sample; repeat from a stopped/restarted session rather than assuming a motor mapping from that number. The values are PID-axis calculations, not motor percentages, thrust predictions or proof of physical control stability.

```text
pid_diag stop
pid_diag
```

Require inactive/invalid diagnostic state. No motor should move at any time. A diagnostic session expires after 60 seconds; restart explicitly for another test. Never use `bench_switch`, `motor_test`, motor pulses or an arming command as part of this acceptance test.

## Test 2 — optional live receiver demand

Only if the receiver is powered safely without ESC/flight battery power, verify fresh `receiver` frames and correctly mapped channels. Keep throttle low. Then:

```text
pid_diag start rx
pid_diag
```

Read `source: rx` and rate demands that track roll/pitch/yaw sticks using the existing configured rate mapping. This remains a rate-only diagnostic even if the ordinary flight-mode configuration says Angle/Horizon. It does not change that stored selection. Receiver loss must clear validity/reset the shadow state; stale demand must not remain presented as live. Restore receiver data and start a new session explicitly if it stopped. No receiver is needed for Test 1; do not add flight battery power just to complete Test 2.

## Timing, termination and bootloader regression

Take a baseline `timing`, exercise one bounded diagnostic session, stop it, then take another `timing` without reboot. Keep both complete reports. Compare incremental skipped slots and cycle overruns over that same interval, not maxima/counters from different boots. Host timing tests are not physical deadline measurements; report any deterioration rather than declaring jitter fixed.

Check explicit stop, timeout and USB disconnect separately. After reconnect, the session must not have restarted. Calibration or motor activity must invalidate/stop diagnostics rather than share their state. Do not intentionally run motors to test mutual exclusion on hardware: that path is covered by host tests.

After diagnostics are stopped and ordinary bootloader guards are satisfied, verify `bl` enters actual STM32 DFU, then return to normal firmware by the established restart procedure without reflashing. Confirm expected version, inactive diagnostics and unchanged saved configuration. Serial disconnect alone does not prove DFU.

## Stop and recovery

Stop for unexpected motor activity, wrong target/version, stale data shown valid, nonfinite values, failure to expire/stop, lost configuration, new USB failures or worsened timing. Disconnect power immediately for unintended motor activity. Preserve command replies and programmer logs; do not raise output limits, relax calibration, force erase or repeatedly reflash. Use the last known-good target-specific image and established independent ROM recovery if normal firmware/USB does not start. No flight acceptance is claimed by these tests.


## Source validation for this increment

Before publication, 50/50 native host tests passed separately for dummy, Kakute F7 HDV and TMOTORF7V2 (150 passes). New tests cover original-equation numerical equivalence, independent production/shadow PID state, fresh gyro sequences, measured timestep boundaries, stale/invalid/reset behavior, bounded sessions and flight-build refusal. A real task-cascade test uses fake sensor/receiver/motor IO to exercise the actual diagnostic hook while gravity is 0.82 g; rate diagnostics still operate while the existing disarmed cascade sends only zero motor frames. Motor mutual exclusion is tested with mocked output only.

Both configurator typechecks, all 19 existing/new one-line configurator CI commands, production UI build and the real native firmware Ports/Modes, storage/export and PID framing contracts passed. Firmware framing checks assert truthful no-IMU refusal, complete responses below 1024 bytes, unchanged configuration exports and disarmed state. The compiled diagnostic object has no motor/mixer-write, arming-write, production-PID or persistence-save references. Production PID, arming, failsafe, estimator, sensor-calibration, gyro, persistence and bootloader implementations are unchanged; the task scheduler definition is unchanged. The task body adds only the isolated diagnostic update hook.

These are software regressions, not physical 1 kHz timing, physical DFU recovery, control stability or flight acceptance. No MCU image was built or flashed by the parent assistant; build it on the owner PC as above. The repository's pre-existing GitHub CI cross-build is a separate check. Known pre-existing PID indentation warnings may also appear when that same original equation is compiled into the isolated diagnostic state namespace. Flat accelerometer calibration/persistence improvements are not included in this PR.
