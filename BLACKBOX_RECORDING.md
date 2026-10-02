# Experimental onboard Blackbox recording

This branch adds a real recording path: production PID/mixer observer -> bounded FIFO -> original Blackbox encoder -> asynchronous FAT32 new-file writer -> SD SPI backend. It does not change PID equations, arming, failsafe, persistent configuration schema, aircraft alignment, or motor ordering. It is not flight qualification.

## Current scope and limitations

- Explicit `blackbox start`, `blackbox stop`, `blackbox status`. The Blackbox panel exposes these operations and requires a card-backup acknowledgment before Start.
- Default 500 Hz capture from the existing 1 kHz PID task. Actual timestamps, missed opportunities, invalid samples and dropped samples are reported. If the card cannot keep up (queue-full drops above 1 % of a 1 s window), the rate halves automatically (500 -> 250 -> 125 Hz floor, never raised mid-session). `blackbox status` reports the effective rate, the requested rate, the reason and the drop percentage, and the log header carries the effective rate. Root cause and host-model numbers for the `-bbl2` writer: [bobflight-firmware/docs/BLACKBOX-THROUGHPUT.md](bobflight-firmware/docs/BLACKBOX-THROUGHPUT.md). Physical-card throughput after `-bbl2` has NOT yet been measured.
- 64-sample capture FIFO plus a 64 KiB encoded-byte ring (SRAM1), no disk calls in the control-loop capture hook. The background driver advances work bounded by the time to the next gyro deadline (20 µs guard, 200 µs cap). Each data sector is written once and read back once. An SD failure stops recording, not the aircraft controller. Very slow cards can still lose samples; losses are counted and reported, never hidden.
- New unique root file `BFL00001.BBL` through `BFL01023.BBL`. Never overwrites/deletes existing files, grows the root directory, formats, or repairs a card.
- FAT32 only, 512-byte sectors, validated capacity/partition/BPB bounds and mirrored FAT sectors before changes. **The root directory must occupy one allocated cluster.** Larger root chains are refused without writing. FAT32 with absent/invalid FSInfo or unsupported backup/volume layouts is also refused. This is not a complete filesystem consistency checker.
- Existing healthy filesystem contents are preserved by new-file allocation and bounded metadata updates. Full-sector write readback is checked. Volume dirty status is set before changes and restored only after successful finalization. FSInfo hints are invalidated in primary and configured backup copies. Power loss is NOT atomic: it can leave an incomplete file, allocated orphan clusters or damaged filesystem metadata. Back up the card first; do not remove power/card while active. Errors requiring repair must be handled on a computer, never by an implicit firmware format/repair.
- No reliable RTC is available. New files use the FAT baseline date 1980-01-01; file dates are not asserted recording times.
- Capture continues without USB or the Blackbox tab. Explicit Stop or an observed armed-to-disarmed transition drains and closes the log. Sessions also stop at approximately ten minutes or 32 MiB. Capture timestamps are session-relative. A clock regression/wrap ends capture.
- **Read-only USB log download, no USB mass-storage mode.** The Configurator's Blackbox tab lists and downloads root `BFLxxxxx.BBL` files (CRC-checked, saved only when complete); the PC utility `tools/download_blackbox.py` remains the fallback. Both are documented in [USB-LOG-EXPORT.md](USB-LOG-EXPORT.md), including files from earlier power cycles. A powered-off card reader remains the last fallback. `error` is not a successful close.
- Maintenance/configuration writes and bootloader entry are refused during recording to preserve metadata consistency. Ordinary radio arming/disarming and existing health/failsafe protections are unchanged. Stop and wait for `done` before `save` or `bl`.

## Recorded data and Explorer

**Log schema 3** (54 fields): per-motor `eRPM[0..3]` (eRPM/100), telemetry-OK mask, filter flags, latched events, loop code and session overruns, plus board, firmware version, schema, loop and filter settings in the header. Field units, bit orders, the event latch/clear rules, the byte budget and the schema 2 → 3 upgrade note are in [bobflight-firmware/docs/BLACKBOX-FIELDS.md](bobflight-firmware/docs/BLACKBOX-FIELDS.md).

The file keeps honest BobFlight firmware headers. Frames contain filtered gyro, pre-filter board-aligned/calibrated gyro, commanded setpoint, real P/I/D terms, clamped controller output, requested logical mixer motor commands, receiver input, mode/failsafe state, timing and validity flags.

- Plot recorded `setpoint[0..2]` and `bobflightError[0..2]`. Stock Explorer's legacy-computed `rcCommands` and `axisError` do not implement BobFlight's rates and must not be used as its control targets/errors.
- `gyroADC` is stored in 0.1 degree/s and uses the verified stock gyro conversion. Custom `bobflightRawGyro` also stores 0.1 degree/s; custom-graph scaling must account for this.
- P/I/D and `bobflightOutput` store normalized command multiplied by 1000. Motor fields use DShot command units, not measured RPM or proof of successful ESC delivery. `bobflightOutputHealthy` marks output-path health. Motor fields are the requested logical mixer commands.
- `bobflightPidValid=0` explicitly distinguishes disarmed, low-throttle reset and priming from a valid PID calculation. Zero PID terms in those frames are not a tuning result.
- `blackbox status` (`blackbox_api: 2`) keeps every api-1 key in order and adds, before `blackbox_end`: `blackbox_rate_requested_hz`, `blackbox_rate_reason` (`default` or `auto-lowered-card-slow`) and `blackbox_drop_pct` (dropped / (frames + dropped) x 100, one decimal). `blackbox_rate_hz` is now the effective rate, no longer a constant. The log header contains `H BobFlight log_rate_hz:<hz> requested_hz:<hz> reason:<reason>` with matching `H I interval`. When the rate was lowered, sector 0 is rewritten in place at close. The Configurator Blackbox tab shows these values exactly as the FC reports them: the drop percentage is the FC's string, never recomputed; the auto-lowered note appears only for `auto-lowered-card-slow`; and any value the FC does not report (for example requested rate, reason and drop % from api-1 firmware) is shown as `unknown`, never 0 or 500.
- Final status contains cumulative loss counters. A dropped tail may not be represented by the last successfully captured frame's counter; save the final status alongside the file. Do not treat a log with losses as complete.

## Verified in the development sandbox

- 97 native CTest tests passed after the integration and filesystem corrections.
- `-bbl2` writer: 106 native CTest tests passed, including `blackbox_sd_throughput_model`. That test drives the real CLI/session/FAT32/SD SPI path against a byte-level card emulator. A realistic card with 80 ms stalls drops 0 frames at 500 Hz, and slow cards auto-lower to 250/125 Hz with honest status and header.
- Actual production task capture hook tested with existing control-routing regression, low-throttle/reset/disarm behavior and real PID terms. Existing bit-exact PID trace regression remains unchanged.
- End-to-end simulated-card test creates a 39,205-byte file containing 600 samples through the real FAT32 implementation, extracts it independently using its directory entry/cluster chain, and compares the complete output byte-for-byte. Existing file contents, exact final size, EOC, mirrored FAT and clean close are checked. Reads are delayed; pending write buffers are checked for immutability.
- Ten independent malformed-volume cases reject before any write, including bounds, mirror mismatch in a later allocation sector, cyclic root, backup FSInfo and unsupported FAT version. Other tests cover full cards, duplicate names, deleted slot reuse, fragmentation and injected I/O failure.
- (Schema 2, earlier work.) Stock `betaflight/blackbox-log-viewer` commit `a84755c5e897c1a3a580424b64c0df066c12c6b4` actually decoded the generated file: 600 valid I frames, 46 fields, one EOF event, zero corrupt frames, correct timestamps and selected P/I/D/output values at zero-based samples 0, 1, 299, 599. Its gyro and DShot physical-percent conversions and trailing-padding handling were checked. The proposed min/max throttle header change was NOT needed. This is parser/conversion testing, not a graphical-app or physical-aircraft test.
- Kakute MCU build and bootloader-image bounds/vector/version checks passed. Image size: 175,776 programmed bytes; RAM data plus BSS: 27,652 bytes (not a measured stack high-water mark). The real-card simulated end-to-end test also passed AddressSanitizer and UndefinedBehaviorSanitizer.
- Configurator typecheck/build and focused recording, protocol, SD-panel and USB bench-recorder tests passed.

- Schema 3: the oracle script below now expects 54 fields and `bobflightSchema` 3, but it has **not** been re-run against the pinned viewer for schema 3. On-box schema 3 checks are the clean-room decoder CTest `blackbox_schema3_decode` and the host encode, capture, task and throughput tests.

The independent oracle script is `bobflight-firmware/tests/verify_blackbox_explorer.cjs`. It takes an external checkout of the pinned viewer and the output from `bobflight_blackbox_card_test`. It requires Node, esbuild and semver (for example via `NODE_PATH`). No GPL viewer code is included in firmware or this repository.

## Optional review build, not an instruction to fly

First keep propellers removed, back up the current controller configuration with `diff all`, retain that text off the controller, and explicitly `save` any intended settings. Back up the SD card on a computer. Keep the last known-good firmware and the established DFU/recovery procedure available. Do not erase NVM or reformat the card.

PowerShell review checkout and normal single-image build:

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\Monko\BF ChatGPt'
if (git status --porcelain) { throw 'Local changes exist. Preserve them before switching revisions.' }
git fetch origin feat/blackbox-recording
if ($LASTEXITCODE -ne 0) { throw 'Fetch failed.' }
git switch --detach origin/feat/blackbox-recording
if ($LASTEXITCODE -ne 0) { throw 'Checkout failed.' }
.\build-main.ps1
if ($LASTEXITCODE -ne 0) { throw 'Build failed. Do not use an older HEX.' }
npm.cmd --prefix bobflight-configurator ci
if ($LASTEXITCODE -ne 0) { throw 'Configurator dependency installation failed.' }
npm.cmd --prefix bobflight-configurator run build
if ($LASTEXITCODE -ne 0) { throw 'Configurator build failed.' }
```

Use the existing verified flasher/DFU procedure only after reviewing this experimental change. Software `bl` entry requires the usual disarmed/motors-stopped/calibration-inactive state and no active recording. Its on-board behavior has not been reverified by this sandbox work. If USB/DFU or recovery is unavailable, stop rather than assuming `bl` can recover non-running firmware.

### First physical check: disarmed, props off

1. After an intentional update, verify `version` ends in `-bbl2-sdread1` (the throughput fix; `-bbl1` is the old writer), the board is Kakute F7 HDV, and `storage`/`diff all` retain the intended saved configuration, including aircraft-specific alignment and motor order. Do not overwrite good settings with defaults.
2. Check read-only `sd probe`. Then use the new panel to start recording deliberately. Wait for `recording`, not merely `initializing`/`preparing`.
3. Record roughly ten seconds while disarmed, optionally move the board gently by hand, then Stop. Wait for `done`. Disarmed PID validity should remain false; gyro movement should still be recorded.
4. Save `blackbox status` and `timing`. Expect `blackbox_rate_hz: 500`, `blackbox_rate_reason: default` and `blackbox_drop_pct: 0.0`. If the reason is `auto-lowered-card-slow`, the card could not sustain 500 Hz; keep the status and card details for diagnosis. Require zero dropped/invalid samples and investigate missed opportunities or worse scheduler timing before relying on the recording rate. Native tests do not establish physical timing.
5. Only after `done`, power off and retrieve the new file with a card reader. Confirm existing card files remain intact and open the new file in Explorer using the recorded fields described above.
6. Stop on missing configuration, storage error, increasing loss counters, hangs, abnormal timing, or damaged files. Retain the card/file/status for diagnosis. Do not repeatedly restart logging on a dirty volume or format it to hide the failure. Use the prior known-good firmware and established recovery method if needed.

No armed, motor-response or props-on test is requested by this first recording check. USB download remains separate unfinished work.
