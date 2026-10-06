# Declarative target foundation

This describes the modern BobFlight target architecture: shared MCU backends, board definitions compiled into firmware defaults, and separate persistent aircraft settings. It is not universal F4/F7/H7 support, hardware qualification, or flight readiness.

## Scope and compatibility

The registry replaces the CMake board-name selection list and generates both the configurator catalog and protocol board-to-MCU map. The original registry foundation did not change firmware runtime. Subsequent [board-defined IMU orientation and calibration migration](bobflight-firmware/docs/imu-orientation.md) preserve unrelated aircraft settings; [explicit MCU backend selection and common HAL contracts](bobflight-firmware/docs/mcu-backends.md) preserve the existing F7 executable behavior. Arming/failsafe policy, PID timing, NVM layout and `diff all` / `save` remain unchanged. Existing targets remain for compatibility; this PR does not expand their hardware capabilities. The old `build-main.ps1` helper is unchanged.

The STM32F722 entry describes the existing sensor-only backend. Its board definition explicitly advertises no motor output or SD logging. STM32F405, STM32F411 and STM32H743 are planning entries with no toolchain and cannot produce hardware builds. Implemented MCU metadata means code exists, not that every peripheral or every board using that MCU is supported. Raspberry Pico is outside this architecture slice.

Runtime receiver-routing refactoring, flipped/arbitrary sensor transforms and additional MCU driver implementations remain deferred. The four board-defined Z-axis quarter turns are implemented. Remaining board-specific driver guards and the bounded existing F7 image validator are intentionally retained. Adding a new JSON definition alone does not port its drivers or authorize a hardware build as qualified.

## Source of truth

- `bobflight-firmware/targets/mcus/*.json`: schema version, canonical MCU backend ID/part, family, core, toolchain and implementation state.
- `bobflight-firmware/targets/boards/*.json`: board ID/display name, MCU reference, board IR path, support level and implemented capability metadata.
- Referenced `boards/**/*.yaml`: existing physical pin, sensor and oscillator facts.
- `scripts/target_registry.py`: standard-library-only validation and resolution.

MCU `id`/`part` identify a canonical backend such as `stm32f722`/`STM32F722`, not a complete package ordering code. Package/bonded-pin validation and broader timer/DMA resource validation remain future work. Do not imply that this registry proves physical wiring or flash size on a connected controller.

Validation rejects unknown JSON fields, duplicate keys, wrong types or schema versions, missing references, path traversal, escaping symlinks, conflicting IR identities, inappropriate support/capability combinations and missing toolchains. Cross builds also require the expected MCU and exact registered toolchain path. No target is guessed when validation fails.

```sh
python3 bobflight-firmware/scripts/target_registry.py list --json
python3 bobflight-firmware/scripts/target_registry.py resolve tmotor_f7_v2 --hardware --json
python3 bobflight-firmware/tests/test_target_registry.py
python3 bobflight-firmware/tests/test_target_artifact.py
```

## Configurator

The existing flash-target selector now draws its board choices from the validated catalog and starts empty. An explicit supported target is required for live and mock flashing; an unknown selection never falls back to the first board. The family browser is informational and cannot select, download, flash, or activate planned hardware. Actual flashing retains its existing MCU and image guards. The protocol MCU union and flash limits must be explicitly implemented before a future family can be enabled.

Run from `bobflight-configurator`:

```sh
npm ci --no-audit --no-fund
npm run targets:check
npm run typecheck
npm --prefix ui run test:targets
npm run build
```

`npm run targets:generate` refreshes checked-in generated files after intentional definition edits. Build/dev hooks regenerate them; CI separately rejects stale committed copies. There is no fallback catalog when the firmware registry is missing or invalid. Building the configurator requires the complete repository and Python 3.

## Windows review/build procedure

No firmware installation is required to review this build-system PR. Use a fresh worktree to keep existing source and build caches intact. The following assumes the existing repository location; these commands do not flash hardware:

```powershell
Set-Location 'C:\Users\Monko\BF ChatGPt'
git fetch origin
if ($LASTEXITCODE -ne 0) { throw 'Fetch failed' }
git worktree add '..\bobflight-target-foundation' origin/feat/target-foundation
if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed; do not overwrite an existing folder' }
Set-Location '..\bobflight-target-foundation'

powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-target.ps1 -ListTargets
if ($LASTEXITCODE -ne 0) { throw 'Catalog validation failed' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-target.ps1 -Target tmotor_f7_v2 -ValidateOnly
if ($LASTEXITCODE -ne 0) { throw 'Target selection rejected' }

# Optional source build of the existing sensor-only target. No automatic flashing.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-target.ps1 -Target tmotor_f7_v2
if ($LASTEXITCODE -ne 0) { throw 'Build failed. Do not use an older artifact.' }
```

Requirements: Python 3.8+, Git, CMake, ARM GCC and MinGW Make. The build helper uses tools on PATH or the existing `BF ChatGPt\tools` installation. `-ListTargets` and `-ValidateOnly` do not require ARM tooling. No implicit target is chosen, no build cache is deleted, and no flash operation is called. Existing cache metadata must identify the selected board, MCU and ARM compiler.

Successful builds validate the HEX and atomically publish a complete HEX/JSON pair under:

```text
artifacts/<board-id>/<artifact-id>/bobflight-<board-id>-main.hex
artifacts/<board-id>/<artifact-id>/bobflight-<board-id>-main.hex.json
```

The helper prints the exact paths. Publication uses a same-filesystem directory rename; interrupted packaging does not expose half a pair. Identical reruns reuse the same directory. Existing conflicting contents are never overwritten. The manifest records the HEX SHA256, target/capabilities, programmed range, observed Git commit and tracked-dirty state, plus definition, IR and toolchain hashes. It is provenance at packaging time, not a signed attestation or reproducible-build proof. Source archives without Git are deliberately not supported by this publishing helper. Outputs are ignored by Git.

Expected results: selecting the sensor target resolves STM32F722 with motor output false; `dummy`, unknown targets and unimplemented backends are rejected for hardware builds. Catalog capability labels must agree with firmware definitions. Build failures leave earlier artifacts alone; never mistake an earlier artifact for a successful new build. Verify the manifest hash against the chosen HEX before a separate installation decision.

## Optional physical installation checks

**Known recovery blocker:** Robert reports that the physical BOOT button on his TMOTORF7V2 is broken. Do not install experimental firmware on that board until a working independent recovery route has been established. Software `bl` requires functioning firmware and USB; it cannot recover failed startup or unavailable USB. The build commands above do not authorize or require installation.

Do not flash a board merely because it has the same MCU. Only use a definition and sensor revision known to match its hardware. Back up `diff all` and existing logs first. Remove propellers, disarm, stop motor tests/calibration, and let recording finish before disconnecting power. Use the existing documented DFU installation process; this script neither enters `bl` nor writes a controller.

After an independently chosen installation, check `version` and `status` identity, actual sensor communication and orientation, and retained configuration against the backup. Verify software `bl` entry on the physical target before relying on it; host tests and HEX vector checks do not demonstrate successful USB re-enumeration. The sensor-only target must not enable motor output. Stop on wrong identity, failed sensor/USB checks, lost settings, unexpected outputs or reset loops. Recover only through an independently verified recovery route with a previously known matching image and configuration backup. Physical BOOT/ROM DFU is an option only on boards where that route actually works. No claim of physical bootloader or flight validation is made by this PR.
