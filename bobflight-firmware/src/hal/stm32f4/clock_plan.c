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

/* Field locations verified against ST CMSIS stm32f405xx/stm32f411xe headers.
 * Reserved bits, SYSCLK selection, MCO and flash cache controls are excluded. */
bool bf_f4_make_clock_register_plan(bf_f4_part_t part, uint32_t hse_hz,
                                    uint32_t vdd_mv,
                                    bf_f4_clock_register_plan_t *out)
{
    bf_f4_clock_register_plan_t p = {0};
    if (!out || !bf_f4_make_clock_plan(part, hse_hz, vdd_mv, &p.clocks))
        return false;
    switch (part) {
    case BF_F4_PART_F405:
        p.pwr_cr.mask = 0x00004000u;
        p.pwr_cr.value = 0x00004000u;
        p.cfgr.value = (5u << 10) | (4u << 13);
        break;
    case BF_F4_PART_F411:
        p.pwr_cr.mask = 0x0000c000u;
        p.pwr_cr.value = 0x0000c000u;
        p.cfgr.value = (4u << 10);
        break;
    default:
        return false; /* A future clock plan must not inherit another part's VOS. */
    }
    p.pllcfgr.mask = 0x0f437fffu;
    p.pllcfgr.value = (uint32_t)p.clocks.pll_m |
        ((uint32_t)p.clocks.pll_n << 6) |
        (((uint32_t)p.clocks.pll_p / 2u - 1u) << 16) |
        (1u << 22) | ((uint32_t)p.clocks.pll_q << 24);
    p.cfgr.mask = 0x0000fcf0u;
    p.flash_acr.mask = 0x00000007u;
    p.flash_acr.value = p.clocks.flash_wait_states;
    *out = p;
    return true;
}

bool bf_f4_timer_prescaler(uint32_t timer_hz, uint32_t tick_hz, uint16_t *psc)
{
    if (!psc || !tick_hz || timer_hz < tick_hz || timer_hz % tick_hz)
        return false;
    const uint32_t divider = timer_hz / tick_hz;
    if (divider > 65536u) return false;
    *psc = (uint16_t)(divider - 1u);
    return true;
}
