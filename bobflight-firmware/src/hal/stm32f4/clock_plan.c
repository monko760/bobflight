/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "clock_plan.h"

bool bf_f4_make_clock_plan(bf_f4_part_t part, uint32_t hse_hz,
                           uint32_t vdd_mv, bf_f4_clock_plan_t *out)
{
    if (!out || hse_hz < 4000000u || hse_hz > 26000000u ||
        hse_hz % 1000000u || vdd_mv < 2700u || vdd_mv > 3600u)
        return false;

    bf_f4_clock_plan_t p = {0};
    p.hse_hz = hse_hz;
    p.pll_m = (uint8_t)(hse_hz / 1000000u);
    p.ahb_div = 1;
    p.voltage_scale = 1;
    switch (part) {
    case BF_F4_PART_F405:
        p.pll_n = 336; p.pll_p = 2; p.pll_q = 7;
        p.apb1_div = 4; p.apb2_div = 2; p.flash_wait_states = 5;
        break;
    case BF_F4_PART_F411:
        /* 96 MHz, not 100 MHz: the main PLL also supplies exact USB 48 MHz. */
        p.pll_n = 384; p.pll_p = 4; p.pll_q = 8;
        p.apb1_div = 2; p.apb2_div = 1; p.flash_wait_states = 3;
        break;
    default:
        return false;
    }
    /* Divide first: the validated input is exactly 1 MHz; no 32-bit overflow. */
    const uint32_t vco_hz = (hse_hz / p.pll_m) * p.pll_n;
    p.sysclk_hz = vco_hz / p.pll_p;
    p.hclk_hz = p.sysclk_hz / p.ahb_div;
    p.usb_hz = vco_hz / p.pll_q;
    p.apb1_hz = p.hclk_hz / p.apb1_div;
    p.apb2_hz = p.hclk_hz / p.apb2_div;
    p.apb1_timer_hz = p.apb1_hz * (p.apb1_div == 1 ? 1u : 2u);
    p.apb2_timer_hz = p.apb2_hz * (p.apb2_div == 1 ? 1u : 2u);
    *out = p;
    return true;
}
