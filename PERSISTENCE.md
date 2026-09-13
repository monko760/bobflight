# Persistent configuration and CLI backups — experimental bench increment

This increment replaces the RAM-only `save` placeholder with versioned controller configuration storage. It does not enable flight, change arming, or alter PR #20 control-mode resolution. ARM remains preview-only; the three bench flight modes retain their established restrictions.

## Scope

Saved together: the existing twelve PID/rates parameters, CRSF receiver UART and AETR/TAER input map, all four ARM/ANGLE/ACRO/HORIZON range configurations, the requested manual Angle/Acro/Horizon mode and manual/AUX source. Save is explicit; Apply changes runtime values without writing flash. A successful save must be read-back verified. A missing, malformed, incompatible or failed record is not presented as a successful restore.

Not included in this schema: gyro/accelerometer calibration, battery/power configuration, DShot bit rate, motor-test state, arming state, receiver freshness or telemetry. These remain governed by their existing behavior. Calibration validity is never silently asserted by this increment; actual arming state and effective/stale-RX mode resolution are never restored as saved settings. A full quad configuration still requires extending the schema to supported future features.

## Commands

- `storage`: versioned backend/status report, saved/dirty state, last error, generation and supported scope.
- `save`: write and verify supported settings. `saved: flash verified` is a real flash acknowledgment. `saved: host_sim verified` is test simulation only. The old bare `saved` response is not accepted by the new UI as evidence of durable storage.
- `diff all` (also `diff`): export supported runtime settings which differ from this firmware's defaults.
- `dump all` (also `dump`): export all supported runtime settings, including default values. On boards without a receiver UART, no invented UART assignment is exported.

Exports are read-only and contain board, configuration schema and firmware version headers. Exporting does not save anything. They intentionally omit `arm`, motor commands, `defaults`, `save`, and automatic reboot. Exports reflect the current runtime configuration, including unsaved changes. Automatic import/replay is **not** implemented in this increment: verify the board/schema/firmware and review commands before applying a backup. A diff is meaningful only relative to the correct defaults; prefer a full export for auditing/restoration. Never blindly paste a Betaflight backup into BobFlight.

The existing `defaults` command still resets PID/rates only and does not auto-save. It does not promise to reset the complete persisted scope or erase storage.

## Installation protocol

1. Remove propellers. Keep the board disarmed and motor-bench functions stopped. Preserve a known-good recovery HEX. Record your current firmware version and take screenshots/readouts of any existing settings; old firmware cannot export values with the new commands.
2. Stop the configurator development server. From `C:\Users\Monko\BF ChatGPt`, run `git status --short`. Stop if there are uncommitted changes you have not preserved; do not reset/discard them. Fetch and check out this PR's branch, not main, until the PR is merged. Use an independent worktree if other feature work is in progress.
3. In `bobflight-configurator`, run `npm.cmd ci`, then `npm.cmd run build`, one command at a time and stop on error. `npm.cmd` avoids the blocked PowerShell launcher without weakening execution policy. Start with `npm.cmd run dev` and open the URL printed by Vite.
4. Build the matching Kakute source using the documented ARM toolchain and the existing build helper with flight, relaxed accelerometer calibration and boot LED diagnostics OFF. The PowerShell helper may itself be restricted by your local policy: do not globally relax policy merely for this step; use the documented direct CMake invocation if needed. This PR is not a firmware flashing operation and is not automatically deployed to your board.
5. Flash only the intended Kakute image using your established recovery-capable process. Do not claim settings survive every reflash: mass erase, downgrade or a firmware image that does not reserve these sectors may destroy stored data. Keep an external versioned export before upgrades. Never copy stored sectors blindly between boards or firmware versions.

## Post-install bench acceptance tests

No arming or motor-start tests are needed for this feature. Software CI is not a substitute for these physical tests.

1. Connect to the actual controller, not Demo/Mock. Run `version`, `status`, `storage`, `ports`, `modes`. Confirm the intended board/build, disarmed state, stopped bench motors, Modes API 2, `semantics: bench-control`, `arm_semantics: preview`, and `backend: flash`. Stop on unsupported backend, unexpected identity, inconsistent reports or a boot error. Empty first-boot storage is not itself a successful restore.
2. Export both full configuration and changes. Check headers and confirm exporting did not change the runtime settings or flash generation. Preserve the exports externally.
3. Record the original ANGLE preview configuration. Apply a disabled ANGLE range with AUX12, minimum 1100, maximum 1450. Record and test separate ACRO and HORIZON ranges too. Test both Manual and AUX source, and manual Angle, Acro and Horizon selections, with motor power disconnected; no arming or motor commands are required. Refresh and verify the exact numeric readback. Save to controller, then inspect `storage`: it must report verified success, no dirty changes, and no storage error. A timeout or missing acknowledgment is **not** proof of failure or success: query state/readback after reconnecting, and do not blindly retry writes.
4. Remove **all** board power, including USB and any other power source. Reconnect and read `modes` and `storage` again. All four saved ranges, the manual selection and the manual/AUX source must be restored exactly, with no dirty changes. Read `control_mode` for the saved manual selection; `requested_mode`/`effective_mode` in `modes` reflect current receiver/fallback conditions, not a saved live state. USB reconnect without a true power cycle does not establish persistence.
5. Restore the original ANGLE settings, save, repeat the complete power cycle, and verify restoration. Leave the physical receiver UART unchanged unless intentionally testing a known wired UART. Confirm existing sensor/receiver displays still work; the known accelerometer discrepancy remains unresolved.
6. Repeat Save without changes and confirm no new generation/erase. Disconnect the UI and ensure editing/saving is blocked; reconnect and require fresh status. Do not attempt physical interrupted-write testing without a controlled bench plan and a verified recovery method; exhaustive simulated write-cut tests alone are not hardware qualification.

## Failure / rollback

On corrupted/unsupported records, save errors, unexpected reset, lost USB, altered arming state or mismatched readback: stop. Capture complete `version`, `status`, `storage`, `ports`, `modes` and any console errors. Do not arm, erase indiscriminately, or restore an unreviewed backup. Revert to the preserved known-good firmware/configurator pair with the established recovery process if required; older firmware may ignore or overwrite the new storage layout. A backup does not make cross-version restoration automatically safe.

## Flash implementation and test limits

The save-reset correction gives the running independent watchdog a temporary /256, 1024-count window only around a disarmed, bench-inactive, calibration-inactive sector erase. This is nominally 8.192 seconds and at least 5.57 seconds at the specified 47 kHz LSI maximum. The [STM32F745 datasheet](https://www.st.com/resource/en/datasheet/stm32f746be.pdf), tables 43/49, specifies up to four seconds for the x8 256 KiB erase. The previous /32, 250-count watchdog could reset during that operation. The exact prior prescaler/reload are restored before returning from erase, including flash-error paths. Failed watchdog configuration/restoration does not resume the controller; the enabled watchdog resets it. Flight-enabled firmware refuses this erase path. No storage schema or sector layout changes are made. USB and live telemetry still pause during the blocking erase; wait for the verified Save reply before unplugging. Physical save and power-cycle validation remain required.

Based on merged PR #20, main `9e4fec7acd52110d472a8bea9ebcc7a02c47a3ea`. STM32F745 device ID 0x449 and a 1024 KiB size signature are checked at runtime. Only Kakute/F745 builds expose the physical backend. Other MCU targets fail closed. The host backend is explicitly process-local simulation, never proof of hardware persistence.

RM0385 rev 2 (ST), flash chapter/Table 3 and sections 3.3.3–3.3.7, device ID section 40.6.1 and flash-size section 41.2: sector 6 is `[0x08080000,0x080C0000)`, sector 7 `[0x080C0000,0x08100000)`, each 262144 bytes. Firmware is constrained to the first 512 KiB by the linker. Configuration sectors are not embedded in HEX/BIN loadable sections. Programming uses x8 access; flash operations temporarily mask normal interrupts and disable/restore D-cache, with explicit barriers and cache invalidation. Same-bank instruction fetches stall: polling bounds are not a wall-clock timeout, USB service may pause, and this is not suitable for active flight. The client allows 15 seconds for Save and disconnects after a save timeout rather than attributing a late reply to the next command.

Each slot has a 32-byte explicitly serialized header and a fixed 96-byte payload: twelve binary32 values, UART/map, stored mode count, source/manual selection, four reserved mode-row slots and reserved bytes. CRC covers metadata and payload; a four-byte seal is written only after readback. The previous committed slot is retained while writing its replacement. Repeated identical Save avoids erase/program operations. Invalid records, incompatible schemas and foreign-board records are not silently loaded or overwritten. A two-row schema-1 record can be restored into the four-row model with new ranges at their current defaults and marked dirty for an explicit upgrade Save. Downgrade to a smaller mode model is rejected.

Tests cover simulated cuts at every programmed-byte boundary, several partially erased prefixes, generation wrap, corrupt-newer-slot fallback, invalid fields and all three manual modes with both source choices. These are software fault models, not physical brownout/flash endurance qualification. An actual power cut can have electrical effects beyond the simulator; retain a recovery image and external backup. Calibration, power and DShot persistence require a later validated schema increment.

## Software validation for this PR

Both dummy and Kakute host configurations passed 39/39 tests after PR #20 integration, including restore of Angle/Acro/Horizon manual selections with both Manual and AUX sources, all four mode rows, malformed-record rejection and simulated interrupted writes. Kakute/F745 cross-build passed with flight, relaxed accelerometer calibration and startup LED diagnostics disabled. HEX checksums and load addresses were checked: no configuration-sector data is present in the image.

Configurator clean install, protocol/UI typechecks, production build and existing protocol/UI test suites passed. Firmware-to-configurator contract tests passed for numeric Ports/Modes and the new storage/backup protocol. Physical power-cycle persistence, brownout behavior and USB recovery during flash operations remain untested on Robert's board. Do not infer hardware qualification from these software tests.
