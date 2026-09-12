/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * GPIO behind opaque board pins. Invalid pin → no-op (dummy IR safe).
 */
#include "hal_f7_priv.h"

#define GPIO_SLOTS 32

typedef struct {
    hal_pin_t pin;
    hal_gpio_cfg_t cfg;
    bool level;
    bool used;
} gpio_slot_t;

static gpio_slot_t g_slots[GPIO_SLOTS];

static gpio_slot_t *slot_for(hal_pin_t pin, bool alloc)
{
    unsigned i;
    if (!hal_pin_valid(pin)) {
        return 0;
    }
    for (i = 0; i < GPIO_SLOTS; i++) {
        if (g_slots[i].used && g_slots[i].pin == pin) {
            return &g_slots[i];
        }
    }
    if (!alloc) {
        return 0;
    }
    for (i = 0; i < GPIO_SLOTS; i++) {
        if (!g_slots[i].used) {
            g_slots[i].used = true;
            g_slots[i].pin = pin;
            g_slots[i].level = false;
            return &g_slots[i];
        }
    }
    return 0;
}

bool hal_gpio_configure(hal_pin_t pin, const hal_gpio_cfg_t *cfg)
{
    unsigned port, num;
    gpio_slot_t *s;
    if (!cfg || !hal_f7_pin_decode(pin, &port, &num)) {
        return false;
    }
    s = slot_for(pin, true);
    if (!s) {
        return false;
    }
    s->cfg = *cfg;
    /* MMIO only on Hardware-verified IR (dummy never reaches here with valid pins). */
    if (hal_f7_mmio_ok(pin, &port, &num)) {
        hal_f7_rcc_gpio_enable(port);
#if defined(BOBFLIGHT_HAVE_CMSIS)
        {
            hal_f7_gpio_regs_t *gpio = hal_f7_gpio(port);
            uint32_t shift2 = num * 2u;
            uint32_t mode = (cfg->mode == HAL_GPIO_OUT) ? 1u :
                            (cfg->mode == HAL_GPIO_AF) ? 2u : 0u;
            if (gpio) {
                uint32_t pull = (cfg->pull == HAL_GPIO_PULL_UP) ? 1u :
                                (cfg->pull == HAL_GPIO_PULL_DOWN) ? 2u : 0u;
                uint32_t spd = (uint32_t)cfg->speed & 3u;
                uint32_t afr_i = num >> 3;
                uint32_t afr_s = (num & 7u) * 4u;
                gpio->MODER = (gpio->MODER & ~(3u << shift2)) | (mode << shift2);
                gpio->PUPDR = (gpio->PUPDR & ~(3u << shift2)) | (pull << shift2);
                gpio->OSPEEDR = (gpio->OSPEEDR & ~(3u << shift2)) | (spd << shift2);
                if (cfg->mode == HAL_GPIO_AF) {
                    gpio->AFR[afr_i] = (gpio->AFR[afr_i] & ~(0xFu << afr_s))
                                      | (((uint32_t)cfg->af & 0xFu) << afr_s);
                }
            }
        }
#endif
    }
    return true;
}

void hal_gpio_init(hal_pin_t pin, hal_gpio_mode_t mode)
{
    hal_gpio_cfg_t cfg;
    cfg.mode = mode;
    cfg.pull = HAL_GPIO_PULL_NONE;
    cfg.speed = HAL_GPIO_SPEED_HIGH;
    cfg.af = 0;
    (void)hal_gpio_configure(pin, &cfg);
}

void hal_gpio_write(hal_pin_t pin, bool high)
{
    gpio_slot_t *s;
    unsigned port, num;
    if (!hal_f7_pin_decode(pin, &port, &num)) {
        return;
    }
    s = slot_for(pin, false);
    if (s) {
        s->level = high;
    }
    if (hal_f7_mmio_ok(pin, &port, &num)) {
#if defined(BOBFLIGHT_HAVE_CMSIS)
        {
            hal_f7_gpio_regs_t *gpio = hal_f7_gpio(port);
            if (gpio) {
                gpio->BSRR = high ? (1u << num) : (1u << (num + 16u));
            }
        }
#endif
    }
}

bool hal_gpio_read(hal_pin_t pin)
{
    gpio_slot_t *s;
    if (!hal_pin_valid(pin)) {
        return false;
    }
    s = slot_for(pin, false);
    return s ? s->level : false;
}
