# Read-only USB log export

This update provides a PC utility, not an integrated configurator download button or USB mass-storage mode. It reads a named root-directory `BFLxxxxx.BBL` from the actual FAT32 card, including files recorded before a reboot or firmware update. It does not require the recorder's RAM state and never issues a card write, format, repair, erase, recording-start, arming or Save command.

Firmware version must end in `-sdprobe2-bbl1-sdread1`. The added `sd read N` API is available only after a successful read-only probe, while disarmed, motor tests/calibration stopped and USB connected. It cannot interrupt an active recorder, including through `sd cancel`. Reads advance asynchronously with a bounded polling quantum, a three-second aggregate timeout, CRC checking and cancellation on guard loss. Normal radio arming/failsafe behavior is unchanged; a guard loss aborts the read, not the aircraft controller.

The PC utility checks every sector response's identity, exact length and IEEE CRC32; validates FAT32 device/partition/volume bounds, FAT capacity, clean flags and mirrored sectors; follows fragmented chains with cycle/length checks; and exports only after the whole file has been read. An existing PC output file is never overwritten. Failed local writes remove only the newly created incomplete output. It accepts root `BFLxxxxx.BBL` files up to 64 MiB; it does not browse subdirectories, repair dirty cards, or offer a complete filesystem consistency check. The root scan is capped at 4096 sectors. MBR support requires exactly one FAT32 partition; GPT/exFAT are refused.

## Before updating

Keep propellers removed. Confirm the recorder reports `done`, not draining/closing/error. Retain the current file and final counters. In the existing configurator, copy `diff all` to a PC backup and use explicit `save` for intended unsaved configuration. Do not restore defaults, erase NVM, change the aircraft-specific yaw/motor ordering, or format the SD card. Keep the last known-good image and established independent DFU recovery route available.

After this change is reviewed and merged, use the normal single-image build. Stop if the working tree has local changes rather than discarding them:

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\Monko\BF ChatGPt'
if (git status --porcelain) { throw 'Preserve local changes before updating.' }
git fetch origin
if ($LASTEXITCODE -ne 0) { throw 'Fetch failed.' }
git switch main
if ($LASTEXITCODE -ne 0) { throw 'Checkout failed.' }
git pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'Update failed.' }
if (!(Test-Path '.\tools\download_blackbox.py')) { throw 'USB export update is not on main yet.' }
.\build-main.ps1
if ($LASTEXITCODE -ne 0) { throw 'Build failed. Do not use an older HEX.' }
npm.cmd --prefix bobflight-configurator ci
if ($LASTEXITCODE -ne 0) { throw 'Configurator dependency installation failed.' }
npm.cmd --prefix bobflight-configurator run build
if ($LASTEXITCODE -ne 0) { throw 'Configurator build failed.' }
```

Expected image: `C:\Users\Monko\BF ChatGPt\bobflight-kakute_f7_hdv-main.hex`. Use the existing verified flasher workflow. With recording completed, disarmed and motors/calibration stopped, issue `bl` and verify the board actually enumerates in DFU before flashing. Do not use `bl discard` to bypass unsaved configuration. This sandbox cannot verify physical bootloader entry; USB/DFU failure is a stop condition, not permission to assume software recovery works.

After flashing, check `version`, `storage` and `diff all`: correct Kakute target, the version suffix above, and the intended saved alignment/motor order/configuration. Stop on missing settings or unexpected defaults. No new recording, motor test or flight is needed to retrieve the existing file.

## Copy an existing file to the PC

Disconnect the configurator and close other serial monitors first. Only one program can own the controller's COM port. Python 3 and its Windows `py` launcher are required. If `py` is unavailable, stop and install/locate Python 3 rather than running commands against a guessed environment.

```powershell
$ErrorActionPreference = 'Stop'
Set-Location 'C:\Users\Monko\BF ChatGPt'
py -3 -m pip install --user pyserial
if ($LASTEXITCODE -ne 0) { throw 'pyserial installation failed.' }
py -3 .\tools\download_blackbox.py --list-ports
if ($LASTEXITCODE -ne 0) { throw 'Port listing failed.' }
$port = Read-Host 'Enter the flight controller COM port from that list (for example COM4)'
$out = Join-Path $env:USERPROFILE ('Downloads\BFL00001-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bbl')
py -3 .\tools\download_blackbox.py --port $port --file BFL00001.BBL --output $out
if ($LASTEXITCODE -ne 0) { throw 'Download failed. Do not use a partial file or format the SD card.' }
Get-Item -LiteralPath $out | Select-Object FullName, Length
Get-FileHash -Algorithm SHA256 -LiteralPath $out
```

For Robert's reported first recording, expect **40,116 bytes**. That size is based on the supplied controller status; its contents have not yet been independently read. Keep the final status showing 650 frames and 3,731 dropped alongside it. Open the downloaded `.bbl` in Blackbox Explorer, using recorded `setpoint` and `bobflightError`, not legacy-computed rate/error fields.

Stop on CRC errors, timeouts, dirty-volume warnings, bounds/chain errors, unexpected file size, missing configuration or bootloader failure. Do not repeatedly reformat/restart logging to hide these. Preserve the card and error output; use a powered-off card reader as the fallback. If the update affects board operation, use the previous known-good image and established recovery procedure. Do not power off during recording/draining/closing.

## Verification and remaining work

Coordinator verified:
- 99 native CTest regressions, including raw-read guards, zero write commands, timeout/cancellation behavior covered by the read path and existing driver tests, active-recorder cancellation protection and SD/recorder mutual exclusion.
- 25 Python tests including a split USB response with the exact firmware terminator, cumulative response-size bounds, command rejection before transmission, CRC, malformed filesystems and exclusive output.
- Real C recorder/FAT32 writer -> sparse card -> PC FAT32 extractor with simulated checksummed sector responses -> exact 39,205-byte match -> stock Explorer at `a84755c5e897c1a3a580424b64c0df066c12c6b4`: 600 samples, no corrupt frames. This is not a physical USB transfer.
- Kakute cross-build and HEX vector/bounds/version checks. Physical `bl`, Windows COM behavior and the user's existing card/file remain to be checked on the board.
- Configurator typecheck/build, SD-read protocol allowlist/framing and bounded-response tests. Mocks honestly return unavailable, not invented card files.

The first physical recording reported 3,731 dropped versus 650 encoded samples, approximately 85.16% lost. This export update does NOT fix recording throughput and does not establish flight readiness. Preserve the file for diagnosis; do not use it as a complete tuning log. The UI now labels 500 Hz as the target rate and warns that an empty final queue does not undo earlier losses.
