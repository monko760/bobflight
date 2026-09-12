# third_party/ — license-audited only

**Disallowed:** any Betaflight / Cleanflight / iNav / EmuFlight / GPLv3 FC tree.
**Disallowed here:** STM32Cube HAL/LL, ST CMSIS-Device packs (BSD-3 / mixed) until separately audited.

When adding a dependency, record SPDX + provenance and keep LICENSE intact.

## Vendored: ARM CMSIS Core (Apache-2.0)

| Field | Value |
|-------|--------|
| Component | ARM CMSIS-Core (Cortex-M7 subset) |
| Upstream | https://github.com/ARM-software/CMSIS_6 |
| Release | v6.3.0 (2026-01-12) |
| SPDX | Apache-2.0 |
| Tarball | https://github.com/ARM-software/CMSIS_6/archive/refs/tags/v6.3.0.tar.gz |
| Tarball SHA-256 | `331df74000876b8fb07933658cbf402c4d9f831b429258792d2c34ab5a6c5bf7` |
| Tree | `third_party/cmsis-core/` (`LICENSE` + `Include/`) |
| What we took | `CMSIS/Core/Include/core_cm7.h`, compiler/version headers, `m-profile/*`, `tz_context.h`, repo `LICENSE` |
| What we did **not** take | CMSIS-RTOS2, CMSIS-Driver, A/R-profile, other `core_*.h`, ST Cube, ST CMSIS-Device |

Owned glue (not ARM): `src/hal/stm32f7/cmsis_cm7_device.h` — F7 family CMSIS macros + OTG_FS IRQ (no pins).

MMIO: `board_mmio_permitted()` is false for dummy / unverified IR. Valid-looking pins still do not poke registers until Hardware marks IR `verified` (bf-derived exception allows Kakute/T-Motor bring-up).

## Vendored: TinyUSB (MIT)

| Field | Value |
|-------|--------|
| Component | TinyUSB device stack (CDC + Synopsys DWC2) |
| Upstream | https://github.com/hathach/tinyusb |
| Release | 0.21.0 |
| SPDX | MIT |
| Tarball | https://github.com/hathach/tinyusb/archive/refs/tags/0.21.0.tar.gz |
| Tarball SHA-256 | `b7cdf35c5ccefb0f61640aff94a732ab4ebcb21498201e4a161545891b23ba01` |
| Tree | `third_party/tinyusb/` (`LICENSE`, `PROVENANCE.md`, minimal `src/`) |
| What we took | core (`tusb.*`), `common/`, `device/`, `osal/` headers, `class/cdc` device, `portable/synopsys/dwc2` device |
| What we did **not** take | host stack, other classes/portables, `hw/` ST Cube BSP, examples, tests |

Owned glue (Apache-2.0, not TinyUSB): `src/hal/stm32f7/tusb_config.h`, `src/hal/stm32f7/stm32f7xx.h` (RM0431 shim — no ST CMSIS-Device), `src/usb/usb_descriptors.c`, `src/hal/stm32f7/hal_usb_cdc.c`.

MCU CMake defines `CFG_TUSB_MCU=OPT_MCU_STM32F7`. Host smoke does **not** link TinyUSB (stdin CDC in `hal_host.c`).

## Still not vendored

| Component | Typical license | Notes |
|-----------|-----------------|-------|
| STM32 HAL / LL | BSD-3-Clause | ST Cube — do not vendor |

F722/F745 link still uses owned `startup_stm32f722.c` + ld scripts + `nosys.specs`.
