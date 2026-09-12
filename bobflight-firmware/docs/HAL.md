# Pin-agnostic HAL

Layers:

- `hal/` — buses, timers, USB, GPIO *handles*
- `board/` — `board_t` from owned IR (dummy until verified)
- `drivers/` — `board_get()` only; never `#define PA4`

Open paths:

| Bus | Dummy IR | Verified IR |
|-----|----------|-------------|
| SPI (gyro) | no CS → not opened as healthy | `hal_spi_open(gyro_spi_bus)` + CS pin |
| UART (CRSF) | no rx/tx → `g_uart` null | `hal_uart_open_cfg` |
| TIM+DMA (DShot) | no motor pins → no handles | `hal_tim_dma_open_cfg` |
| USB CDC | host: stdin; MCU: stub until stack | same API |

CMSIS Device/Core is not vendored. Define `BOBFLIGHT_HAVE_CMSIS` only after
`third_party/` records SPDX + provenance.

## CMSIS + MMIO

MCU builds define `BOBFLIGHT_HAVE_CMSIS` and include ARM CMSIS Core from
`third_party/cmsis-core/` (Apache-2.0). ST device headers are not vendored.

`board_mmio_permitted()` is true only when `ir_verified && !is_dummy`.
Dummy IR keeps every pin `HAL_PIN_INVALID` and `ir_verified = false`.
