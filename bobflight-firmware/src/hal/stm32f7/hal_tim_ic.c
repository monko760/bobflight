/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Kakute F7 HDV M1 listen-after-TX input capture on PB0 / TIM3_CH3 (AF2).
 * Does NOT alter the TIM3_UP DMA TX path (DMA1 Stream2 Channel5).
 *
 * R0b: after arm, wait for TX DMA TC then poll CC3IF for edge times.
 * Flight-quality IRQ/DMA IC is an open follow-up (see docs smoke note).
 */
#include "hal_f7_priv.h"
#include "board/board.h"
#include "hal/hal.h"

#include <string.h>

#ifndef R
#define R(base, offset) (*(volatile uint32_t *)((uintptr_t)(base) + (offset)))
#endif

#define TIM3_BASE   0x40000400u
#define DMA1_BASE   0x40026000u
#define DMA1_S2_TCIF (1u << 21) /* LISR TCIF2 */

static uint16_t *g_buf;
static size_t g_cap;
static size_t g_n;
static bool g_armed;
static bool g_in_ic;
static uint16_t g_saved_ccmr2_lo;
static uint16_t g_saved_ccer_ch3;

static bool kakute_ok(void)
{
    const board_t *b = board_get();
    return b && board_mmio_permitted() && b->board_id &&
           strcmp(b->board_id, "kakute_f7_hdv") == 0;
}

static void restore_ch3_pwm(void)
{
    uintptr_t t = TIM3_BASE;
    uint32_t ccmr2 = R(t, 0x1C);
    uint32_t ccer = R(t, 0x20);
    ccmr2 = (ccmr2 & ~0xFFu) | (uint32_t)g_saved_ccmr2_lo;
    ccer = (ccer & ~(0xFu << 8)) | ((uint32_t)g_saved_ccer_ch3 << 8);
    R(t, 0x1C) = ccmr2;
    R(t, 0x20) = ccer;
    g_in_ic = false;
}

static bool wait_tx_dma_done(unsigned spins)
{
    /* DMA1 Stream2 = TIM3_UP TX. TCIF2 in LISR. */
    while (spins--) {
        if (R(DMA1_BASE, 0x00) & DMA1_S2_TCIF) {
            return true;
        }
        /* Also accept stream disabled (EN cleared after complete). */
        {
            uintptr_t s2 = DMA1_BASE + 0x10u + 0x18u * 2u;
            if ((R(s2, 0) & 1u) == 0u) {
                return true;
            }
        }
    }
    return false;
}

static void program_ch3_ic(void)
{
    uintptr_t t = TIM3_BASE;
    uint32_t ccmr2 = R(t, 0x1C);
    uint32_t ccer = R(t, 0x20);

    g_saved_ccmr2_lo = (uint16_t)(ccmr2 & 0xFFu);
    g_saved_ccer_ch3 = (uint16_t)((ccer >> 8) & 0xFu);

    /* CH3: input on TI3, no filter/prescaler. */
    ccmr2 = (ccmr2 & ~0xFFu) | (1u << 0);
    /* CC3E + both edges (CC3P | CC3NP). */
    ccer = (ccer & ~(0xFu << 8)) | (1u << 8) | (1u << 9) | (1u << 11);
    R(t, 0x1C) = ccmr2;
    R(t, 0x20) = ccer;
    R(t, 0x10) = 1u << 3; /* clear CC3IF (SR) */
    g_in_ic = true;
}

bool hal_dshot_m1_ic_arm(uint16_t *edge_buf, size_t cap)
{
    if (!edge_buf || cap == 0u || !kakute_ok()) {
        return false;
    }
    g_buf = edge_buf;
    g_cap = cap > HAL_DSHOT_M1_IC_MAX_EDGES ? HAL_DSHOT_M1_IC_MAX_EDGES : cap;
    g_n = 0u;
    g_armed = true;

    /* Best-effort: wait for outbound TIM3_UP DMA to finish, then IC. */
    if (!wait_tx_dma_done(200000u)) {
        /* Still arm; take() may time out with zero edges. */
    }
    program_ch3_ic();
    /* Ensure CEN stays on so captures land. */
    R(TIM3_BASE, 0x00) |= 1u;
    return true;
}

size_t hal_dshot_m1_ic_take(void)
{
    uintptr_t t = TIM3_BASE;
    unsigned spins;
    uint32_t prev = 0u;
    bool have_prev = false;

    if (!g_armed) {
        return 0u;
    }
    g_armed = false;

    if (!g_in_ic) {
        return 0u;
    }

    /*
     * Poll CC3IF for a short window (~telem frame). ESC reply is ~21 bits
     * at 5/4 DShot bitrate (~25–40 µs @ DShot300). Spin budget is coarse.
     */
    spins = 50000u;
    while (spins-- && g_n < g_cap) {
        if (R(t, 0x10) & (1u << 3)) {
            uint32_t ccr = R(t, 0x3C); /* CCR3 */
            R(t, 0x10) = 1u << 3;
            if (have_prev) {
                uint16_t delta = (uint16_t)((ccr - prev) & 0xFFFFu);
                g_buf[g_n++] = delta == 0u ? 1u : delta;
            }
            prev = ccr;
            have_prev = true;
        }
    }

    restore_ch3_pwm();
    return g_n;
}

void hal_dshot_m1_ic_cancel(void)
{
    g_armed = false;
    g_n = 0u;
    g_buf = NULL;
    g_cap = 0u;
    if (g_in_ic) {
        restore_ch3_pwm();
    }
}

uint16_t hal_dshot_m1_ic_bit_period_ticks(void)
{
    /* TIM3 ARR+1 == DShot bit period ticks; telem bit = 4/5 of that. */
    uint32_t arr = R(TIM3_BASE, 0x2C);
    uint32_t dshot_ticks = arr + 1u;
    uint32_t telem = (dshot_ticks * 4u) / 5u;
    if (telem == 0u) {
        telem = 1u;
    }
    if (telem > 0xFFFFu) {
        telem = 0xFFFFu;
    }
    return (uint16_t)telem;
}
