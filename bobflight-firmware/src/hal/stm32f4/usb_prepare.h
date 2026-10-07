/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_HAL_STM32F4_USB_PREPARE_H
#define BOBFLIGHT_HAL_STM32F4_USB_PREPARE_H

#include <stdbool.h>
#include <stdint.h>
#include "clock_plan.h"

#if !defined(__arm__) || !defined(__thumb__)
#error "usb_prepare requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for usb_prepare"
#endif

#if defined(BF_F4_COMPONENT_F411XE)
#error "BF_F4_COMPONENT_F411XE must NOT be defined for usb_prepare"
#endif

/**
 * STM32F405xG USB Platform Preparation Interface.
 *
 * HARDWARE & SAFETY CONTRACT:
 * - BUS_POWERED policy requires the board to be powered by USB with actual wiring verified.
 * - PA9 policy requires actual VBUS wire presence verified on PA9.
 * - This module configures PA11/12 and configures PA9 only in PA9 mode; it does NOT apply GCCFG.
 *   The caller later must use matching policy with TinyUSB.
 * - One hardware-write attempt per reset, including failed attempts. Invalid input,
 *   context, clock/time or ownership preflight failures do not consume the attempt.
 * - Requires exclusive access to the affected RCC/GPIO registers, including from
 *   nonmaskable handlers or DMA. PRIMASK does not prove ownership.
 * - Caller supplies the plan from successful clock startup for verified board HSE.
 *   Register matching is not a physical clock measurement or chip/density probe.
 * - Physical PLL/USB status is not verified.
 * - Clock and GPIO registers may remain modified on failure; do NOT initialize the controller on failure.
 * - Requires reset-time Thread mode with IPSR = 0 and PRIMASK = 1 (interrupts masked).
 * - Target compilation restricted strictly to STM32F405xG (BF_F4_COMPONENT_F405XG).
 */

typedef enum bf_f405_usb_vbus_t {
    BF_F405_USB_VBUS_BUS_POWERED = 1,
    BF_F405_USB_VBUS_PA9 = 2
} bf_f405_usb_vbus_t;

typedef enum bf_f405_usb_prepare_status_t {
    BF_F405_USB_PREPARE_OK = 0,
    BF_F405_USB_PREPARE_INVALID = 1,
    BF_F405_USB_PREPARE_CONTEXT = 2,
    BF_F405_USB_PREPARE_CLOCK = 3,
    BF_F405_USB_PREPARE_BUSY = 4,
    BF_F405_USB_PREPARE_TIME = 5,
    BF_F405_USB_PREPARE_WRITE = 6,
    BF_F405_USB_PREPARE_ALREADY = 7
} bf_f405_usb_prepare_status_t;

bf_f405_usb_prepare_status_t bf_f405_usb_prepare(
    const bf_f4_clock_plan_t *clocks,
    bf_f405_usb_vbus_t vbus
);

#endif /* BOBFLIGHT_HAL_STM32F4_USB_PREPARE_H */
