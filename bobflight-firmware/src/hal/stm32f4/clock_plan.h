/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_F4_CLOCK_PLAN_H
#define BOBFLIGHT_F4_CLOCK_PLAN_H
#include <stdbool.h>
#include <stdint.h>

typedef enum { BF_F4_PART_F405=405, BF_F4_PART_F411=411 } bf_f4_part_t;
typedef struct {
    uint32_t hse_hz, sysclk_hz, hclk_hz, usb_hz;
    uint32_t apb1_hz, apb2_hz, apb1_timer_hz, apb2_timer_hz;
    uint16_t pll_n;
    uint8_t pll_m, pll_p, pll_q, ahb_div, apb1_div, apb2_div;
    uint8_t flash_wait_states, voltage_scale;
} bf_f4_clock_plan_t;

/* PROVISIONAL, TEST-ONLY COMPONENT. Device-limit review is not complete.
 * Pure planning only: no MMIO, clock switching, flash writes or hardware probe.
 * Requires a verified HSE crystal (whole MHz, 4..26 MHz), 2.7..3.6 V supply,
 * and part-specific voltage scale 1. Scale is logical, NOT PWR register bits.
 * Failure leaves *out unchanged. No fallback to HSI or another MCU.
 * This component does not enable an F4 hardware backend. */
bool bf_f4_make_clock_plan(bf_f4_part_t part, uint32_t hse_hz,
                           uint32_t vdd_mv, bf_f4_clock_plan_t *out);
#endif
