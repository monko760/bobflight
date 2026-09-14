# Angle, Acro and Level (Horizon): bench development increment

**Not flight-qualified. Do not arm or attempt flight using this increment.** The configured ARM range now feeds guarded arm/disarm input; the bench lockout and flight-enable restrictions remain. See [configured ARM integration](CONFIGURED-ARM.md). The existing accelerometer discrepancy and estimator limitations remain open.

## Three control modes

| Modes tab label | Firmware mode | Behavior |
|---|---|---|
| Angle | `ANGLE` / `angle` | Existing limited-tilt self-leveling outer loop, requesting up to 25 degrees of tilt. |
| Acro | `ACRO` / `acro` | Existing stick rate curve supplies roll/pitch/yaw rate demands. No leveling in the setpoint generator. |
| Level (Horizon) | `HORIZON` / `horizon` | Self-leveling near centered roll/pitch sticks, smoothly blending toward Acro rate demands with larger deflection. No altitude hold or recovery guarantee. |

Horizon combines two **degrees/second rate demands before the existing inner PID**—not raw attitude angles, motor values, or two PID outputs. Both roll and pitch use the same weight `w = clamp((max(abs(roll),abs(pitch)) - 0.1) / 0.9, 0, 1)` on normalized receiver stick inputs. Up to 10% deflection uses the existing Angle demand; full roll or pitch deflection uses the rate demand. Intermediate values interpolate linearly. Yaw always uses the configured rate curve. This is a deliberately simple, clean-room bench controller, not a claim of Betaflight-equivalent behavior.

## Selection and safety behavior

- Boot: manual source, Angle. New Acro/Horizon ranges are disabled; existing ARM/ANGLE range defaults are preserved.
- `control_mode angle|acro|horizon` sets the manual selection only. It does not turn off AUX selection. `control_source manual|aux` explicitly chooses the source and returns a full Modes snapshot.
- With AUX enabled, exactly one matching control-mode range selects that mode. No match, stale/invalid receiver data, or more than one match falls back to Angle. Overlap is reported as a conflict, not resolved with a hidden priority.
- The existing staged failsafe leveling override takes precedence over all modes. Failsafe timers and throttle policy are unchanged; ARM switch input follows the separately documented configured range.
- Configuration edits/source/manual-mode changes require disarmed state, no active/pending motor output and no manual calibration. Automatic AUX resolution is evaluated in the controller task; software tests use mocked arming to exercise it.
- In `BOBFLIGHT_FLIGHT_ENABLE=1` builds, non-Angle manual selection and AUX-source activation are refused, and resolution is forced to Angle. This patch does not enable that build option.

All modes still depend on the current attitude estimator's loop-health gates, including pitch-singularity rejection. Acro/Horizon here are **not unrestricted gyro-only aerobatic flight support**. Disarmed firmware resets the PID as before; changing a Modes-tab indicator does not prove active physical PID operation. Mode transition transients and hardware response are not yet qualified.

The Modes response is API 2, with four rows, explicit ARM semantics (`configured` on current firmware, `preview` on older firmware), selected source, requested mode, last controller-pass effective mode and conflict indication. The UI treats these as timestamped snapshots, not live flight telemetry. Requested and effective values can differ until the next task pass or during failsafe. Old API-1 firmware remains a two-row preview in the new UI and cannot enable the new AUX source. Older configurators should reject the new API rather than misrepresent its semantics.

Apply updates runtime configuration. This persistence increment adds explicit verified Save for all four mode ranges, the manual mode and manual/AUX source. See [Persistent configuration](PERSISTENCE.md) for supported hardware, installation, power-cycle tests and limitations.

## Install on the development branch

1. Props off; disconnect the flight battery and motor power. Record current settings and keep a known-good bench firmware file. If your checkout has local changes, stop and preserve them—do not reset or overwrite them.
2. In PowerShell, enter the existing checkout and fetch the branch:

   ```powershell
   Set-Location 'C:\Users\Monko\BF ChatGPt'
   git status --short
   git fetch origin
   # First checkout only:
   git switch --track origin/feat/flight-modes-bench
   # If that local branch already exists instead:
   # git switch feat/flight-modes-bench
   # git pull --ff-only
   git log -1 --oneline
   powershell -NoProfile -ExecutionPolicy Bypass -File .\build-flight-modes.ps1
   ```

   Build must finish successfully and print the SHA-256 of `bobflight-kakute-f7-hdv-flight-modes-bench.hex`. The dedicated script sets flight enable OFF and relaxed accelerometer checks OFF. Do not use a stale HEX if the build fails. Check the commit against the PR before testing.
3. Build/start the configurator from this same branch using the existing development procedure (`npm ci` then the workspace's documented run command in `bobflight-configurator`). Do not pair old configurator assets with the API-2 firmware. Flash the new HEX using the already verified Kakute F7 HDV STM32F745 DFU/configurator procedure. Stop on MCU mismatch, unexpected erase range, failed verification or an unexplained disconnect. This guide does not authorize bypassing flasher safeguards or motor/arm tests.

## Post-update checks: props off, no motor power

1. Reconnect USB. `status` must still report disarmed and bench-only. In Modes, verify ARM displays configured-switch semantics on current firmware (preview-only on older firmware) and Angle, Acro, Level (Horizon) are listed. Fresh boot source/requested mode must be Manual/Angle; Acro and Horizon ranges disabled. If these do not match, stop and verify matching firmware/UI revisions.
2. With a connected receiver and three-position switch on AUX2, configure **non-overlapping** enabled ranges: Angle 900–1300, Level (Horizon) 1301–1700, Acro 1701–2100. Each Apply must be confirmed by board readback. Explicitly select AUX source. Keep the separate actual arm switch low; never attempt arming. Refresh after moving the switch: requested/effective mode should follow Angle → Horizon → Acro, with a fresh receiver indication.
3. Test fallbacks without starting motors: create overlapping ranges, refresh and verify conflict with Angle fallback; restore non-overlapping ranges. Turn off the transmitter and refresh to verify stale receiver and Angle fallback. Return the transmitter, switch source to Manual, and set `control_mode angle`. Save the desired source/manual mode and ranges, remove all board power, reconnect and verify restoration. Without Save, a reboot restores the previous stored configuration, or defaults when no valid record exists.

Stop immediately if the UI claims armed/flight-ready, a readback differs from the request, source/mode changes are accepted while a motor test or calibration is running, a conflict does not fall back to Angle, or settings appear retained without verified persistence support. Do not use a motor test to investigate this increment. Collect `status`, `timing`, `modes` and sensor snapshots; no active control-loop or flight-safety claim follows from successful UI checks.

Before ending the bench session, compare two `timing` snapshots at least 60 seconds apart. Expected: task cadence consistent with the known-good configuration, no new cycle overruns, and no unexplained growing missed-slot counts. Stop on regressions; host/cross-build tests do not establish on-board timing under the new Horizon workload.

## Recovery

Disconnect motor power; stop testing. Return to the previously verified bench firmware and matching configurator revision via the established DFU procedure. Reconnect with props off, verify disarmed/bench-only defaults and sensor/timing health, and re-enter session settings as necessary. If USB/DFU or MCU detection is unexpected, stop rather than force flashing. No automated flashing, arming, release publication or flight enable is performed by the source patch.
