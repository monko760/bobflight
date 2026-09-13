# CLI `bl` / `BL` — bench ROM DFU test

This update implements **software entry to the ST ROM bootloader**, not a new flash bootloader. It is a bench-only development increment, not hardware-qualified. Test **Holybro Kakute F7 HDV first**, using a board with a personally verified hardware BOOT/DFU recovery path. Flight enablement and arming logic are unchanged. T-Motor motor output and flash configuration support remain unavailable; Holybro's existing capabilities are retained.

**Broken T-Motor BOOT button:** leave its current firmware untouched for now. A successful Holybro test does not prove F722 startup or ROM entry. Before installing an experimental image on T-Motor, establish independent recovery: repaired/verified BOOT0 access or verified SWD programmer access. Do not guess pads or short arbitrary contacts. If startup/USB fails, a CLI command cannot rescue it. Do not treat a brief USB disconnect as proof of DFU.

## Behavior

- `bl` or `BL` requests ROM bootloader entry. Letter case is ignored. It requires disarmed, motors stopped, no active AUX bench session, no manual calibration and supported MCU/ROM vectors. It never automatically disarms, cancels a bench session, saves, erases flash or changes option bytes/watchdog timeout.
- Dirty persisted-scope configuration refuses plain `bl`: first copy `diff all`, then `save` and verify `storage` says saved/dirty=0 on a supported flash backend. Alternatively, `bl discard` explicitly accepts losing **unsaved RAM changes**; it does NOT bypass motor/arming/calibration/platform checks or erase already-saved flash. The T-Motor sensor-only target has unsupported storage and is normally dirty, so later testing there needs explicit `bl discard` after backup.
- Even after a successful save, calibration/power/DShot settings currently excluded from persistence remain RAM-only and are lost across reset. Back up relevant telemetry separately. This update does not add persistence for those settings.

There is a nonblocking 100 ms opportunity to transmit the acknowledgement while USB/scheduler/watchdog servicing continues. Buffered commands are ignored while the request is pending. Safety/configuration conditions are checked again immediately before reset. The terminal reset path disconnects USB, clears stale reset flags, writes a paired one-shot DTCM `.noinit` cookie and issues SYSRESETREQ. Early Reset_Handler consumes the cookie before normal data/BSS/FPU/clock/USB initialization, checks reset cause/device/ROM vectors, permits a bounded disconnect-settling interval, and transfers to ROM with a new stack and vector table. The normal `reboot` command is unchanged.

## 1. Build on the owner's Windows PC

Do not overwrite or stash unrelated local work. After the branch has been published, create a separate worktree:

```powershell
cd "C:\Users\Monko\BF ChatGPt"
git fetch origin
if ($LASTEXITCODE -ne 0) { throw "Fetch failed" }
git worktree add --detach "C:\Users\Monko\BobFlight-BL-Test" origin/feat/cli-bootloader
if ($LASTEXITCODE -ne 0) { throw "Stop; do not overwrite an existing folder" }
cd "C:\Users\Monko\BobFlight-BL-Test"
git rev-parse HEAD
powershell -ExecutionPolicy Bypass -File .\build-bootloader-bench.ps1 -Board kakute_f7_hdv
if ($LASTEXITCODE -ne 0) { throw "Build failed; do not use an older HEX" }
```

The script uses the existing ARM/CMake/MinGW tools and Python. It builds in a separate board-specific directory with flight, relaxed calibration, reset-only and blocking LED diagnostics OFF. Wrong cached board/MCU/compiler is rejected. Windows script execution has not been tested here.

**First stop:** require `PASS kakute_f7_hdv HEX`, a SHA256 and successful command completion. The output is `bobflight-kakute_f7_hdv-bootloader-bench.hex`. Expected firmware is `0.2.0-prototype-switchbench2-bl1`. Review the source commit and build output before first installation. A host test or object-only ARM check is not a complete local firmware link or hardware test.

## 2. Install on Holybro only after that checkpoint

1. Remove ALL propellers, disconnect the battery and use USB only. On the current working Holybro firmware, record `version`, `status`, `diff all`, `storage`, `calibration`, `timing` and relevant excluded RAM settings. Keep the previous known-working matching HEX available. Verify physical BOOT enters STM32 ROM DFU, then reconnect normally. Stop if that recovery route is not working.
2. In the existing BobFlight Configurator flasher choose **Kakute F7 HDV / F745**, never T-Motor/F722. Enter ROM DFU via the verified hardware method. Select only the new Holybro HEX. Use affected-sector erase/readback verification, not full-chip mass erase: the F745 configuration slots are outside this image's 512 KiB program window. Full erase or a different firmware may remove saved settings even though `bl` itself does not.
3. Require successful flash readback verification. Reconnect without BOOT and verify exact `-bl1` version, disarmed state and no motor/bench activity. `help` must list `bl / BL`. Review `storage` and `diff all`; stop if previously saved configuration has changed unexpectedly. No npm/configurator update is required for a CLI-only test.

## 3. Acceptance test — no powered motors and no arming test

1. Use `bench_stop` if an old explicit bench session is still active; wait for outputs to report inactive. Finish/cancel any manual calibration using the existing calibration commands. On Holybro, back up `diff all`, use `save` only if needed, and require verified flash save plus `storage` dirty=0 before plain `bl`.
2. Enter `bl` once. Expect the acknowledgement, CDC COM-port disconnect, then an actual **STM32 BOOTLOADER / DFU device** (USB VID:PID `0483:DF11`). Verify it using the flasher's device selection or Windows USB tools. Keep it idle in DFU for **at least 60 seconds** to check for watchdog/reset cycling. Do not rush a flash to hide an unstable bootloader session. Merely losing the serial port is a failure to prove DFU.
3. Without flashing anything, unplug USB and reconnect normally. BobFlight should return, not loop back into ROM. Confirm the same version, disarmed/no motor activity and saved configuration unchanged. Repeat with uppercase `BL` to check the alias and one-shot behavior. Do NOT test refusal guards by arming or spinning motors; those cases are host-tested.

Record the command response, DFU identification, 60-second stability result, return-to-CLI result, `storage`, `diff all` and timing before/after. Reset clears timing counters; compare fresh intervals, not cumulative counts across reset. No timing sample proves flight qualification.

## Stop and recover

Stop for `bl unavailable`, absent/unstable DFU, unexpected reset cycling, wrong version/target, changed saved settings, any active motor, or lost USB after the new image. Use Holybro's verified physical BOOT method and restore the matching known-working image, then check stored settings from the backup. Do not weaken guards or extend watchdog timeout to make a failing test look successful. Do not flash the T-Motor just because the Holybro worked.

## Source evidence and validation limits

Implementation is independent Apache-2.0 code, not copied from Betaflight. ST **AN2606 Rev61**, sections 4.8, 38 and 39, tables 81/83/85/177, documents F72/F74 system ROM at `0x1FF00000..0x1FF0EDBF`, RAM use and watchdog handling. The official source is [AN2606](https://www.st.com/resource/en/application_note/an2606-introduction-to-system-memory-boot-mode-on-stm32-mcus-stmicroelectronics.pdf); the reviewed revision was retrieved from a mirror. The reviewer's claim that these ROM bootloaders never refresh a hardware-enabled watchdog was contradicted by the actual ST tables; no proposed watchdog extension was applied.

Host policy/CLI tests and integration checks cover refusals, explicit discard, nonblocking delay/wraparound, changed-state cancellation, paired-cookie consumption, reset causes, vector bounds, actual host CLI behavior and startup integration. ARM object compilation/disassembly checks the final stack handoff. These cannot prove physical reset, USB enumeration, ROM revision behavior or T-Motor recoverability. The owner performs the full local image build and the above hardware acceptance procedure before this feature can be called validated on a board.

### Recorded software checks for this increment

47/47 host tests passed separately with dummy, Kakute and T-Motor selections. The full host CLI transcript test passed; synthetic HEX validation accepts each matching board/version and rejects swapped boards. F722 and F745 bootloader objects compiled with warnings-as-errors at both -O0 and -O2. Disassembly checks found no stack loads/stores or C calls after MSP replacement in any of the four objects. No MCU firmware ELF/HEX was linked or generated locally in the agent workspace for this increment. Full owner-PC build and physical DFU acceptance remain pending; GitHub CI, if reported separately, is not a hardware result.
