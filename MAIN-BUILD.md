# One Kakute build: flash → configure → props-off PID check

The supported Kakute entrypoint is `build-main.ps1`, producing **`bobflight-kakute_f7_hdv-main.hex`**. This same image supports persistent Save, the configured ARM switch, manual Acro/Angle/Level selection, individual motor diagnostics and armed closed-loop control. There is no feature-profile switch. TMotor remains a separate sensor-only hardware target because its motor backend is not implemented.

This is a functional development milestone, not flight qualification. Keep all propellers removed throughout. Normal low-throttle arming, a fresh inactive→active ARM switch transition, gyro readiness, timing and failsafe checks remain. Acro is gyro-only; no accelerometer calibration is required for this Acro check.

## 1. Obtain the matching source and build once

Use this after the single-build change is available in the branch you intend to test. Do not flash an older HEX if a command fails. Updating source does not flash the controller. Do not discard local edits or switch branches blindly.

```powershell
Set-Location -LiteralPath 'C:\Users\Monko\BF ChatGPt'
if (!(Test-Path -LiteralPath '.\build-main.ps1')) { throw 'The single-build change is not in this checkout. Stop; do not run an old build script.' }
git status --short
if ($LASTEXITCODE -ne 0) { throw 'Not the expected repository.' }
git log -1 --oneline
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify source revision.' }
# Review any local edits shown above before proceeding.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-main.ps1
if ($LASTEXITCODE -ne 0) { throw 'Firmware build failed. Do not flash an older HEX.' }
Get-FileHash -Algorithm SHA256 -LiteralPath '.\bobflight-kakute_f7_hdv-main.hex'
Set-Location -LiteralPath '.\bobflight-configurator'
npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'Configurator install failed.' }
npm.cmd run typecheck
if ($LASTEXITCODE -ne 0) { throw 'Configurator typecheck failed.' }
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Configurator build failed.' }
npm.cmd --prefix ui run dev
```

The dev server stays running. Open the local address it prints. The script preserves an existing build directory if its board/compiler identity does not match, and validates the image before copying the final HEX. Old bench/development scripts now stop with directions to this one script; old CMake ON/OFF profile options also stop explicitly rather than change behavior silently.

## 2. Back up, enter DFU, flash, reconnect

Before updating, keep props off, battery disconnected and ARM inactive. Connect by USB. Save/export the current `diff all` and `dump all` output separately. Exports do not include replayable accelerometer coefficients; retain controller flash and your prior known-working source/image. Do not mass-erase configuration storage.

Use the configurator's existing bootloader/DFU flow. With the board disarmed, motor tests stopped, no calibration running and configuration already saved, the `bl` command requests system-bootloader entry and disconnects normal serial. It is an action, not a read-only diagnostic. Do not use `bl discard` to bypass unsaved changes. Select the exact new `bobflight-kakute_f7_hdv-main.hex` and the intended Kakute DFU device, flash, then reconnect normal serial as instructed by the flasher.

Before relying on software bootloader entry, establish the board's independent recovery procedure. A physical BOOT/DFU route is useful only if its operation has been confirmed on that board. Software `bl` cannot recover firmware that will not start or expose USB. No new physical bootloader/recovery test has been performed by the remote build checks.

After reconnecting, check:

```text
version
status
storage
modes
receiver
```

Expected: board `kakute_f7_hdv`, version `0.2.0-prototype-flightdev1-bl1-calstore2-piddiag2-sdprobe2`, status `flight_mode: closed-loop-development`, `flight_enabled: 1` in modes/storage, initially disarmed, and supported flash storage. The status label describes the control capability of the single main image; it is not a second selectable build. Stop on a wrong board/version, failed storage restore, unexpected active output, or unreliable USB.

## 3. Configure and confirm persistence on the same image

Keep ARM inactive and throttle minimum. In the configurator, verify the actual receiver UART, channel map, throttle direction, and configured ARM AUX/range against receiver readback. Preserve the aircraft's existing settings rather than guessing replacements. Select **Acro** in Modes, or use:

```text
control_mode acro
modes
storage
diff all
save
storage
dump all
```

Expected: requested mode `acro`, source `manual`, your intended ARM range, and Save reply `saved: flash verified`. Afterwards storage must report `saved`, `dirty: 0`, `last_error: none`. Save is available in this image, but still refused while armed, during active motor tests or calibration. Host-simulation save replies are not physical flash verification.

An older saved `control_source aux` is not silently treated as a successful unchanged restore. Review any migration notice, the restored manual mode and all saved settings before explicitly saving. In the main image, ARM remains a working switch; Angle/Acro/Level AUX ranges are retained as stored configuration but do not switch runtime modes. Use manual Acro selection for this milestone.

Disconnect **all** power, including USB and battery, then reconnect USB and repeat `storage`, `modes`, `receiver` and `dump all`. Compare PID/rates, receiver map/UART, ARM range, Acro selection, power/DShot settings and saved calibration metadata against the pre-cycle snapshot. A clean state is not enough by itself: the values must match. Do not continue if settings disappear or change unexpectedly.

## 4. Props-off functional PID check

1. Confirm every propeller is removed. Support the aircraft, keep hands/cables clear of spinning motor bells, and make battery disconnection accessible. Verify individual motors and configured ordering using the existing bounded motor test, then stop that test fully. An individual motor test does not exercise the PID controller.
2. With throttle at minimum and ARM inactive, connect motor power and let the gyro finish stationary startup calibration. Confirm a fresh receiver and requested Acro mode. Move ARM from inactive to active once. Confirm the board arms; if refused, inspect the reported state rather than bypass a guard. Returning ARM outside its range must disarm and stop outputs. Repeat this stop check before the motion test. **Low throttle is not a substitute for disarming.**
3. Arm at minimum throttle, then use only enough throttle to enter the active control path: the current implementation resets PID below approximately 5% normalized throttle. Above that threshold, briefly rotate the frame about one axis at a time and observe differential motor response. Acro responds to **rotation rate**, not to a static tilted angle. Do not hold a stick deflected or sustain high output to force a response.
4. Return the frame to rest, then explicitly disarm. Settling toward low output is useful evidence, but exact return to idle is not a universal pass/fail test: throttle and retained I-term affect outputs without propeller feedback. Unexpected direction, unexplained sustained escalation, resets, stale receiver/gyro data or failure to stop are reasons to stop and inspect evidence—not to increase throttle or remove guards.

This sequence checks that configured input, arming, gyro feedback, PID, mixing and motor output connect end-to-end. It does not validate hover, tuning or loaded flight behavior.

## 5. Capture evidence without confusing diagnostic modes

The current Blackbox tab is a **browser-side asynchronous USB snapshot recorder**, not an onboard high-rate flight recorder. It polls supported read-only commands (`sensors`, `receiver`, `power`, `status`, `pid_diag status`) serially and exports JSON/CSV. USB loss stops capture. Retain version, configuration and before/after timing counters alongside observations.

`pid_diag` is a separate **zero-output, disarmed** diagnostic. Its motor values are virtual commands, not measured RPM, and it is not a recording of the armed flight PID. Do not start that diagnostic while performing the armed test or interpret its inactive status as evidence that the armed controller is inactive. A dedicated high-rate armed PID-term recorder remains additional work.

On a stop condition: disarm, disconnect motor power if output does not stop, preserve logs/configuration, and investigate before retrying. There is no requirement to switch to a separate bench image to save or diagnose this main build.

## SD card diagnostics

The Blackbox tab now includes an onboard SD-card panel. See [SD-CARD.md](SD-CARD.md) for its read-only scope and tests. It does not yet provide flight-log downloads or USB removable-drive mode. The existing JSON/CSV recorder remains a separate low-rate USB bench tool.
