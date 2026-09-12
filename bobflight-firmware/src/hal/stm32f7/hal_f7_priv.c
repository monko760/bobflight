/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "hal_f7_priv.h"
#include "board/board.h"
#include <stdint.h>

bool hal_f7_pin_decode(hal_pin_t pin, unsigned *port, unsigned *num)
{
    if (!hal_pin_valid(pin)) {
        return false;
    }
    unsigned p = HAL_PIN_PORT(pin);
    unsigned n = HAL_PIN_NUM(pin);
    if (p > 10u || n > 15u) {
        return false;
    }
    if (port) {
        *port = p;
    }
    if (num) {
        *num = n;
    }
    return true;
}

bool hal_f7_mmio_ok(hal_pin_t pin, unsigned *port, unsigned *num)
{
    if (!board_mmio_permitted()) {
        return false;
    }
    return hal_f7_pin_decode(pin, port, num);
}

void hal_f7_rcc_gpio_enable(unsigned port)
{
    if (port > 10u || !board_mmio_permitted()) {
        return;
    }
#if defined(BOBFLIGHT_HAVE_CMSIS)
    HAL_F7_RCC->AHB1ENR |= (1u << port);
    (void)HAL_F7_RCC->AHB1ENR; /* sync delay */
#else
    (void)port;
#endif
}

void hal_f7_rcc_otgfs_enable(void)
{
    if (!board_mmio_permitted()) {
        return;
    }
#if defined(BOBFLIGHT_HAVE_CMSIS)
    HAL_F7_RCC->AHB2ENR |= HAL_F7_RCC_AHB2ENR_OTGFSEN;
    (void)HAL_F7_RCC->AHB2ENR;
#endif
}

hal_f7_gpio_regs_t *hal_f7_gpio(unsigned port)
{
    if (port > 10u || !board_mmio_permitted()) {
        return 0;
    }
    return (hal_f7_gpio_regs_t *)(uintptr_t)(HAL_F7_GPIOA_BASE + port * HAL_F7_GPIO_STRIDE);
}
