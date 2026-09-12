/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owned shim so TinyUSB portable/synopsys/dwc2 (dwc2_stm32.h) can compile
 * without ST CMSIS-Device / Cube. Values are public RM0431 MCU-map facts
 * for STM32F74x OTG_FS — not board pins, not Betaflight.
 */
#ifndef BOBFLIGHT_STM32F7XX_SHIM_H
#define BOBFLIGHT_STM32F7XX_SHIM_H

#include <stdint.h>
#include "cmsis_cm7_device.h"
#include "core_cm7.h"

/* OTG_FS AHB2 peripheral base (RM0431) */
#ifndef USB_OTG_FS_PERIPH_BASE
#define USB_OTG_FS_PERIPH_BASE  0x50000000UL
#endif

/* Updated by hal_clock_init after PLL lock; TinyUSB uses for turnaround / delays */
extern uint32_t SystemCoreClock;

#endif /* BOBFLIGHT_STM32F7XX_SHIM_H */
