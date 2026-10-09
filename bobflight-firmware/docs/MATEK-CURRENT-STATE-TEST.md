# Matek F722-PX current-state bench validation

Goal: validate fresh configuration, sensors, receiver, bounded motor output and diagnostic acquisition. This is not flight qualification or a closed-loop flight test. Arming policy is unchanged. The normal development loop remains 1 kHz.

## Installation

Remove every propeller. Disconnect ESC/motor power for installation and sensor checks. Confirm physical BOOT/ROM DFU recovery works on this board and verify the existing firmware's software `bl` entry. Save any diagnostic output you want to compare; do not import an old configuration dump into schema13. A BOOT button's presence alone does not prove recovery.

This is a fresh configuration installation. With recovery confirmed, use the established STM32 DFU procedure for a deliberate full **internal** flash erase and flash the validated `matek_f722_px` image. Do not erase external NOR or change option bytes. The build scripts only build and validate; they do not flash hardware. If flashing or image validation fails, stop rather than selecting an older HEX by accident.

Expected version suffix: `store13-cal2-mount1-actual1-dshot1-flashprobe1-bb4-baro1`. Confirm target `matek_f722_px`, disarmed state, schema13, and four bound motor outputs. `fresh_install_required` is a stop condition, not a reason to repeatedly Save.

## Staged tests

| Stage | Test | Pass criterion / evidence |
|---|---|---|
| USB and identity | Capture `version`, `status`, `storage`, `timing`, `diff all` | Correct target/version; no reset loop; schema13; intended 1 kHz control configuration |
| Orientation | Re-enter reviewed mounting settings; previously reported mounting was roll180/pitch0/yaw180, which must match this physical setup. Move roll, pitch and yaw separately | 3D aircraft follows the real direction; stationary attitude settles; yaw is gyro-relative, not a magnetic compass |
| Persistence | Change one per-axis Actual rate, explicitly `save`, remove USB power, reconnect and compare `diff all` | Exact saved value and mounting survive power loss; returning the test value also requires Save. Do not infer persistence from RAM Apply |
| Calibration | Calibrate stationary; test/save accelerometer calibration only with the board genuinely level or the appropriate face procedure | Valid raw/sensor health; explicitly saved accelerometer calibration survives reboot. Gyro bias is recalibrated on startup |
| Receiver | Inspect Receiver page with transmitter on, then off, with ESC power still disconnected | Correct channel direction/range/center and throttle-low state; stale/lost-link reporting when transmitter is off. Reconnect before any motor test |
| Barometer | Run `barometer`, wait through startup reference collection, then repeat | Detected BMP280 ID0x58; finite plausible pressure/temperature, fresh valid samples; altitude becomes valid after32 good samples. Gentle height change has consistent direction. Unsupported/error/stale values are not measurements |
| External flash | Run `flash_info` with motors stopped and no recording/probe already active | Complete framed JEDEC/status response. Recognized geometry when applicable. `flash_recording_supported: no` remains expected. This command cannot erase/program |
| Timing | Compare `timing` before/after several sensor/diagnostic queries | No resets, sustained overrun growth, runaway lateness or unhealthy output state. Return full replies rather than treating a model result as physical timing proof |
| Single-motor output | Secure the assembly, reconnect suitable ESC power with common ground, keep props off, select DShot300 and bidirectional off. Use the existing bounded individual-motor UI at the lowest supported command | Only the selected motor spins, correct M1–M4 identity, automatic timeout stops it, Stop stops it. Repeat separately for each output, never arm |
| Software bootloader | After stopping motors, disconnect ESC power and finish/save or deliberately discard pending edits. Run `bl` | Expected USB disconnect and actual ROM DFU enumeration. If refused, retain the reason and resolve the stated condition, not the guard |

Stop immediately for an unexpected motor, continued rotation beyond the test timeout, reset, output-health failure, abnormal current/heat, incorrect axes or a failed Stop. Disconnect ESC power. Do not compensate by raising throttle. A logic analyzer can additionally verify DShot300 timing/CRC and idle behavior; motor rotation alone does not establish waveform correctness.

## Blackbox boundary

Schema4, lossless I/P encoding and 71/79-field stock-Explorer decoding are software-verified using synthetic SD/FAT files. **Matek onboard NOR recording/download is not implemented.** The existing logger also refuses initiating motor tests during recording. Do not bypass that gate, substitute USB polling for high-rate Blackbox, or use this update for PID tuning or prop-on tests.

Return: build commit/version; the initial CLI replies above; `sensors`, `calibration`, `receiver`, `barometer`, `flash_info`; before/after power-cycle `diff all`; and a short M1–M4 pass/fail/timeout/Stop table. Do not include personal identifiers unnecessarily. Physical test results have not yet been collected.
