/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_HAL_STM32F4_GYRO_GPIO_PREPARE_H
#define BOBFLIGHT_HAL_STM32F4_GYRO_GPIO_PREPARE_H

#include <stdbool.h>
#include <stdint.h>
#include "board/board.h"
#include "spi_component.h"

#if !defined(__arm__) || !defined(__thumb__)
#error "gyro_gpio_prepare requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for gyro_gpio_prepare"
#endif

#if defined(BF_F4_COMPONENT_F411XE)
#error "BF_F4_COMPONENT_F411XE must NOT be defined for gyro_gpio_prepare"
#endif

/**
 * STM32F405xG Gyro GPIO Preparation Interface.
 *
 * HARDWARE & SAFETY CONTRACT:
 * - Pre-validates caller-supplied board_t pin routing before any MMIO.
 * - Supports only SPI1: PA5 SCK, PA6 MISO, PA7 MOSI, PA4 CS, PC5 DRDY.
 * - One hardware-write attempt per cold reset. Preflight context/routing failures
 *   do not consume the attempt.
 * - Requires reset-time Thread mode with IPSR = 0 and PRIMASK = 1 (interrupts masked).
 * - Preloads PA4 CS HIGH in BSRR before configuring PA4 as output mode.
 * - Configures AF5 for PA5/6/7 and input mode for PC5 without setting up EXTI IRQ.
 * - Preserves PA9, PA11, PA12 and all unrelated pin/register fields.
 * - Caller owns these pins/RCC exclusively, including against DMA and NMI.
 * - Partial GPIO/clock changes may remain after failure; no rollback promised.
 * - Readbacks verify register acceptance, not physical traces or pin voltage.
 * - Target compilation restricted strictly to STM32F405xG (BF_F4_COMPONENT_F405XG).
 */

typedef enum bf_f405_gyro_gpio_status_t {
    BF_F405_GYRO_GPIO_OK = 0,
    BF_F405_GYRO_GPIO_ERR_INVALID = 1,
    BF_F405_GYRO_GPIO_ERR_CONTEXT = 2,
    BF_F405_GYRO_GPIO_ERR_WRITE = 3,
    BF_F405_GYRO_GPIO_ERR_ALREADY = 4
} bf_f405_gyro_gpio_status_t;

bf_f405_gyro_gpio_status_t bf_f405_gyro_gpio_prepare(const board_t *board);
/* Thread-only runtime callback; ctx must be NULL. Inert until all preparation
 * readbacks succeed. IRQs may be enabled. BSRR writes request, but do not prove,
 * electrical CS state. No sensor/board hardware qualification is implied. */
void bf_f405_gyro_cs_cb(void *ctx, bool assert_cs);

#endif /* BOBFLIGHT_HAL_STM32F4_GYRO_GPIO_PREPARE_H */
