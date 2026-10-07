/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal TinyUSB shim for STM32F405xG.
 */
#ifndef BOBFLIGHT_STM32F4XX_SHIM_H
#define BOBFLIGHT_STM32F4XX_SHIM_H

#if !defined(__arm__) || !defined(__thumb__)
#error "stm32f4xx.h shim requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for stm32f4xx shim"
#endif

#if defined(BF_F4_COMPONENT_F411XE) || defined(BF_F4_COMPONENT_F411) || defined(STM32F411xx)
#error "F411 targets are rejected by stm32f4xx shim"
#endif

#include <stdint.h>
#include "cmsis_gcc.h"

typedef enum {
    OTG_FS_IRQn = 67
} IRQn_Type;

#if defined(USB_OTG_HS_PERIPH_BASE)
#error "This component only implements OTG_FS"
#endif
#if defined(USB_OTG_FS_PERIPH_BASE) && USB_OTG_FS_PERIPH_BASE != 0x50000000UL
#error "Incorrect F405 OTG_FS address"
#endif
#if defined(USB_OTG_FS_MAX_IN_ENDPOINTS) && USB_OTG_FS_MAX_IN_ENDPOINTS != 4U
#error "Incorrect F405 OTG_FS endpoint count"
#endif

/* OTG_FS AHB2 peripheral base (RM0090) */
#ifndef USB_OTG_FS_PERIPH_BASE
#define USB_OTG_FS_PERIPH_BASE  0x50000000UL
#endif

#ifndef USB_OTG_FS_MAX_IN_ENDPOINTS
#define USB_OTG_FS_MAX_IN_ENDPOINTS 4U
#endif

/* SystemCoreClock used by TinyUSB for turnaround / delays */
extern uint32_t SystemCoreClock;

static inline void NVIC_EnableIRQ(IRQn_Type IRQn)
{
    if (IRQn == OTG_FS_IRQn) {
        *(volatile uint32_t *)0xE000E108UL = (1UL << 3);
    }
}

static inline void NVIC_DisableIRQ(IRQn_Type IRQn)
{
    if (IRQn == OTG_FS_IRQn) {
        *(volatile uint32_t *)0xE000E188UL = (1UL << 3);
        __DSB();
        __ISB();
    }
}

#endif /* BOBFLIGHT_STM32F4XX_SHIM_H */
