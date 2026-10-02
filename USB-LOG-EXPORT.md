# Read-only USB log export

There are two read-only ways to copy a root-directory `BFLxxxxx.BBL` from the actual FAT32 card over USB, including files recorded before a reboot or firmware update: the **Download** section on the Configurator's Blackbox tab, and the PC utility `tools/download_blackbox.py`, which remains the fallback. A powered-off SD card reader is the last fallback. USB mass-storage mode is not offered. Neither path needs the recorder's RAM state, and neither issues a card write, format, repair, erase, recording-start, arming or Save command.

Firmware version must end in `-sdprobe2-bbl2-sdread1` (or the earlier `-sdprobe2-bbl1-sdread1`). The added `sd read N` API is available only after a successful read-only probe, while disarmed, motor tests/calibration stopped and USB connected. It cannot interrupt an active recorder, including through `sd cancel`. Reads advance asynchronously with a bounded polling quantum, a three-second aggregate timeout, CRC checking and cancellation on guard loss. Normal radio arming/failsafe behavior is unchanged; a guard loss aborts the read, not the aircraft controller.

Both the Configurator and the PC utility check every sector response's identity, exact length and IEEE CRC32. Both validate the FAT32 device/partition/volume bounds, FAT capacity, clean flags and mirrored FAT sectors, and follow fragmented chains with cycle/length checks. Both accept root `BFLxxxxx.BBL` files up to 64 MiB, cap the root scan at 4096 sectors, refuse a root entry with that name that is a subdirectory, and do not browse subdirectories, repair dirty cards or offer a complete filesystem consistency check. MBR support requires exactly one FAT32 partition; GPT/exFAT are refused (the Configurator shows the card's `sd_filesystem_hint` and points to a card reader).

How the file reaches the PC differs:

- **Configurator (browser):** the file is handed to the browser as one download (a Blob) only after every sector verified and the length matches the directory entry. Nothing is written before that, so an aborted download leaves no partial file. Where the file goes, and what happens if a file with the same name already exists, is up to the browser's own download settings (most browsers add a number to the name).
- **`tools/download_blackbox.py`:** it writes to the output path you give it. An existing output file is never overwritten, and a failed local write removes only the newly created incomplete output.

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

## Download from the Configurator (Blackbox tab)

Connect the Configurator to the controller and open the **Blackbox** tab. The section **Download logs from the onboard SD card** works like this:

1. Disarm, stop motor tests and calibration, and wait until the onboard recorder reports `done`. The buttons stay disabled, with the reason shown, while recording, armed, disconnected, before the post-flash checks are done, while the SD card check or USB bench recorder runs, or while a settings save, defaults restore or storage refresh is in progress. The firmware still enforces its own locks; its refusal lines are shown exactly as sent.
2. Click **Probe card and list logs**. Every list and every download starts with a fresh `sd probe`, waits for `sd_state: done` (15 s cap), re-reads `blackbox status` and `status` (it refuses while a recording is active or the controller is armed; a real reply that does not report the state, as from older firmware, shows "Recorder state unknown" or "Arm state unknown" and relies on the firmware lock, while a missing reply, a timeout or a busy connection stops with nothing read), reads the FAT32 root and lists the `BFLxxxxx.BBL` files with their sizes. It ends with `sd cancel` once an SD command has gone out.
3. Click **Download BFLxxxxx.BBL** for the file you want. Sectors are read one at a time (`sd read N`, never more than one in flight), each checked against its CRC-32. A progress bar shows bytes and sectors. A sector with a CRC mismatch is read again once; a second mismatch stops the download and names the sector.
4. The browser saves the file only after every sector verified and the length matches the directory entry. Any error, timeout, **Cancel download**, tab change or disconnect discards the partial data, and `sd cancel` is sent while connected (once an SD command has gone out). After a timeout the USB link is reset: reconnect and download again. If another command was using the connection, nothing was read: try again.

The Configurator re-reads `blackbox status` and `status` right before the first sector is read and refuses while recording or armed. If the firmware's reply does not report the recorder or arm state, the download continues and shows "Recorder state unknown" or "Arm state unknown". Arming, starting a recording or a motor test **during** a download is not watched by the Configurator: the flight controller's own guard stops the read (`sd_data_error: guard check failed`), and the Configurator then shows that line and saves nothing.

Check the saved size against the listed size, and keep the final `blackbox status` counters alongside it.

## Fallback: copy an existing file with the PC utility

Use this if the Configurator download is unavailable or fails repeatedly. Disconnect the configurator and close other serial monitors first. Only one program can own the controller's COM port. Python 3 and its Windows `py` launcher are required. If `py` is unavailable, stop and install/locate Python 3 rather than running commands against a guessed environment.

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
