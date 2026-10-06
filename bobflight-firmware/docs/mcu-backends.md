# MCU backend selection and common HAL contracts

The build now selects an explicit MCU backend instead of hardwiring the F7 source list, USB identity, include path and linker into the shared application build. This is a structural step toward F4/F7/H7 support, not a new hardware port or universal board compatibility.

## Selection contract

`cmake/select_mcu_backend.cmake` accepts an exact implemented MCU part. The selected module exports:

- `BF_BACKEND_FAMILY` and `BF_BACKEND_MCU`: selected family and exact part.
- `BF_HAL_SOURCES`: ordered family implementation sources, including startup and ROM-bootloader handling.
- `BF_HAL_INCLUDE_DIRS`: private family/device headers.
- `BF_USB_MCU`: TinyUSB MCU identity.
- `BF_LINKER_SCRIPT`: the part-specific memory layout.

Existing STM32F722 and STM32F745 select the F7 module with unchanged source order, startup, flags, USB identity and linker layouts. Missing, unknown, ambiguous or unimplemented parts fail configuration. The previous default-to-F722 linker fallback is removed. Direct inclusion of the F7 module also rejects unsupported parts.

STM32F405, STM32F411 and STM32H743 remain planned and cannot produce a hardware image. An F7-family label does not enable every F7 part either. The registry still enforces board identity, support level and the exact registered toolchain before hardware builds. Tests ensure implemented registry entries have matching backend selection.

## Shared interfaces, family-owned implementations

Shared application and CLI code now includes `hal/boot_crumb.h` and `hal/sd_spi_hw.h`, not headers under `hal/stm32f7/`. The SD SPI bind/cancel API and implementation are unchanged. Existing F7 include paths remain compatibility wrappers.

Early optional diagnostics call `hal_boot_diagnostic_pulse()`. The existing F7 implementation retains its previous PA2 behavior; common code no longer names that pin. The old F7-only function spelling remains a source alias. This does not make PA2 a safe or correct diagnostic output on other boards: future backends must supply their own verified implementation or explicitly leave optional diagnostics unsupported. Boot-stage numbers remain unchanged; storage placement, reset initialization and fault behavior belong to the backend.

There is no runtime dispatch table or per-sample abstraction overhead. Arming/failsafe policy, PID/scheduler cadence, receiver freshness, motor capability flags, saved-settings layout and `diff all` / `save` remain unchanged.

## Validation scope

Validation includes exact part/source/linker/USB selection; rejection of planned, unknown and ambiguous parts; common/legacy header compatibility in both include orders; shared-source family-header restrictions; and nine boot diagnostic/reset preprocessing combinations. The bootloader binding regression follows the new source-list location without dropping its guard/order checks.

The existing F722 normal and diagnostic-enabled images are compared byte-for-byte against pre-change baselines. Matching executable images demonstrate preservation of those builds, not new MCU capability, physical ROM-bootloader entry or flight qualification. Native tests cover the existing timing, logging, persistence and safety paths. No hardware was flashed.

## Next actual port work

Each new MCU variant still needs correct CPU/FPU flags, startup/vector table, clock/USB timing, flash geometry and reserved settings storage, GPIO/pinmux, SPI/UART/ADC, timers/DMA/interrupt handling, and ROM-bootloader behavior. Board definitions then need verified package/bonded-pin, oscillator, sensor, motor/timer/DMA and UART assignments. Existing board-specific driver assumptions remain work to remove or replace with validated resource tables. A metadata entry or common interface header is not an implementation.

Do not mark a new backend or capability implemented just because it compiles. Preserve unsupported-capability rejection, run bounded source and timing regressions, then establish independent recovery and perform separately authorized physical bring-up. Software `bl` must be verified on the actual target before relying on it.

## Optional source-only Windows review

No firmware rebuild or installation is required from Robert. These optional commands preserve the existing tree, validate selection, and build only the existing sensor-only F722 target using the normal helper:

```powershell
Set-Location 'C:\Users\Monko\BF ChatGPt'
git fetch origin
if ($LASTEXITCODE -ne 0) { throw 'Fetch failed' }
git worktree add '..\bobflight-mcu-backends' origin/feat/mcu-backend-boundaries
if ($LASTEXITCODE -ne 0) { throw 'Worktree creation failed; do not overwrite an existing folder' }
Set-Location '..\bobflight-mcu-backends'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-target.ps1 -Target tmotor_f7_v2 -ValidateOnly
if ($LASTEXITCODE -ne 0) { throw 'Target selection rejected' }
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build-target.ps1 -Target tmotor_f7_v2
if ($LASTEXITCODE -ne 0) { throw 'Build failed. Do not use an older artifact.' }
```

Expected: F7/STM32F722 backend selection, the existing sensor-only capability limits, successful image checks and printed artifact/manifest paths. The helper does not flash hardware. Existing Python, CMake, ARM GCC and MinGW Make requirements apply. See [the target build and installation protocol](../../TARGETS.md#optional-physical-installation-checks) for backups, expected physical checks, stop conditions and recovery requirements. The reported broken TMOTORF7V2 BOOT button still blocks experimental installation without independent recovery; no hardware testing is requested by this source-only change.
