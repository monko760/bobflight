/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Kakute F7 HDV M1–M4 listen-after-TX input capture (R0c).
 *   M1 PB0 AF2 TIM3_CH3 | M2 PB1 AF2 TIM3_CH4 — share TIM3_UP DMA1 S2/C5
 *   M3 PE9 AF1 TIM1_CH1 | M4 PE11 AF1 TIM1_CH2 — share TIM1_UP DMA2 S5/C6
 * Does NOT alter TIM3_UP / TIM1_UP DMA TX paths.
 *
 * R0c sharpen (vs R0b M1-only):
 * - Wait BOTH UP DMA TCs before programming IC (TX starts TIM3+TIM1 together).
 * - Brief post-TC settle (~1 ARR) so the last TX bit period finishes.
 * - Parallel CCxIF collect (hal_dshot_ic_collect) so M2–M4 share the listen
 *   window instead of sequential take() burns.
 * - Quiet-gap early exit after edges stop (fail/timeout without full spin).
 *
 * Polled CCxIF; flight-quality IRQ/DMA IC remains an open follow-up.
 * ir_verified=false until props-off smoke.
 */
#include "hal_f7_priv.h"
#include "board/board.h"
#include "hal/hal.h"

#include <string.h>

#ifndef R
#define R(base, offset) (*(volatile uint32_t *)((uintptr_t)(base) + (offset)))
#endif

#define TIM3_BASE   0x40000400u
#define TIM1_BASE   0x40010000u
#define DMA1_BASE   0x40026000u
#define DMA2_BASE   0x40026400u
#define DMA1_S2_TCIF (1u << 21) /* LISR TCIF2 */
#define DMA2_S5_TCIF (1u << 11) /* HISR TCIF5 */

#define IC_SPIN_BUDGET   50000u
#define IC_QUIET_GAP     2000u  /* spins with no new edge → end listen */

typedef struct {
    uint16_t *buf;
    size_t cap;
    size_t n;
    bool armed;
    bool in_ic;
    bool collected; /* take() already has edges from collect() */
    uint16_t saved_ccmr_byte;
    uint16_t saved_ccer_nibble;
    uint32_t prev_ccr;
    bool have_prev;
} ic_motor_t;

static ic_motor_t g_m[HAL_DSHOT_IC_MOTOR_COUNT];
static bool g_tim3_dma_waited;
static bool g_tim1_dma_waited;

static uintptr_t motor_tim(unsigned motor)
{
    return (motor < 2u) ? TIM3_BASE : TIM1_BASE;
}

static unsigned motor_ch(unsigned motor)
{
    static const unsigned ch[4] = {3u, 4u, 1u, 2u};
    return ch[motor];
}

static bool kakute_ok(void)
{
    const board_t *b = board_get();
    return b && board_mmio_permitted() && b->board_id &&
           strcmp(b->board_id, "kakute_f7_hdv") == 0;
}

static bool wait_dma_tc(uintptr_t dma_base, unsigned stream, uint32_t tcif_mask,
                        bool hisr, unsigned spins)
{
    const uint32_t isr_off = hisr ? 0x04u : 0x00u;
    while (spins--) {
        if (R(dma_base, isr_off) & tcif_mask) {
            return true;
        }
        {
            uintptr_t s = dma_base + 0x10u + 0x18u * stream;
            if ((R(s, 0) & 1u) == 0u) {
                return true;
            }
        }
    }
    return false;
}

/* After UP DMA TC, let ~1 bit period elapse so the last CCR update finishes. */
static void settle_one_bit(uintptr_t t)
{
    uint32_t arr = R(t, 0x2C);
    uint32_t start = R(t, 0x24); /* CNT */
    unsigned guard = (arr + 1u) * 4u + 64u;
    while (guard--) {
        uint32_t cnt = R(t, 0x24);
        uint32_t delta = (cnt - start) & 0xFFFFu;
        if (delta >= (arr + 1u)) {
            break;
        }
    }
}

static void restore_channel_pwm(unsigned motor)
{
    ic_motor_t *m = &g_m[motor];
    uintptr_t t = motor_tim(motor);
    unsigned ch = motor_ch(motor);
    uint32_t ccmr_off;
    uint32_t ccmr;
    uint32_t ccer;
    unsigned shift;

    if (!m->in_ic) {
        return;
    }

    ccmr_off = (ch <= 2u) ? 0x18u : 0x1Cu;
    ccmr = R(t, ccmr_off);
    ccer = R(t, 0x20);

    if (ch == 1u || ch == 3u) {
        ccmr = (ccmr & ~0xFFu) | (uint32_t)m->saved_ccmr_byte;
    } else {
        ccmr = (ccmr & ~0xFF00u) | ((uint32_t)m->saved_ccmr_byte << 8);
    }
    shift = (ch - 1u) * 4u;
    ccer = (ccer & ~(0xFu << shift)) | ((uint32_t)m->saved_ccer_nibble << shift);

    R(t, ccmr_off) = ccmr;
    R(t, 0x20) = ccer;
    m->in_ic = false;
}

static void program_channel_ic(unsigned motor)
{
    ic_motor_t *m = &g_m[motor];
    uintptr_t t = motor_tim(motor);
    unsigned ch = motor_ch(motor);
    uint32_t ccmr_off = (ch <= 2u) ? 0x18u : 0x1Cu;
    uint32_t ccmr = R(t, ccmr_off);
    uint32_t ccer = R(t, 0x20);
    unsigned shift = (ch - 1u) * 4u;
    uint32_t ccif = 1u << ch;

    if (ch == 1u || ch == 3u) {
        m->saved_ccmr_byte = (uint16_t)(ccmr & 0xFFu);
        ccmr = (ccmr & ~0xFFu) | (1u << 0);
    } else {
        m->saved_ccmr_byte = (uint16_t)((ccmr >> 8) & 0xFFu);
        ccmr = (ccmr & ~0xFF00u) | (1u << 8);
    }
    m->saved_ccer_nibble = (uint16_t)((ccer >> shift) & 0xFu);

    ccer = (ccer & ~(0xFu << shift)) |
           ((1u | (1u << 1) | (1u << 3)) << shift);

    R(t, ccmr_off) = ccmr;
    R(t, 0x20) = ccer;
    R(t, 0x10) = ccif;
    m->in_ic = true;
    m->have_prev = false;
    m->prev_ccr = 0u;
    m->n = 0u;
    m->collected = false;
}

static uint32_t channel_ccr(uintptr_t t, unsigned ch)
{
    return R(t, 0x34u + (ch - 1u) * 4u);
}

static void ensure_dma_waited(unsigned motor)
{
    /* TX fires TIM3_UP + TIM1_UP together; wait both before first IC. */
    if (!g_tim3_dma_waited) {
        (void)wait_dma_tc(DMA1_BASE, 2u, DMA1_S2_TCIF, false, 200000u);
        settle_one_bit(TIM3_BASE);
        g_tim3_dma_waited = true;
    }
    if (!g_tim1_dma_waited) {
        (void)wait_dma_tc(DMA2_BASE, 5u, DMA2_S5_TCIF, true, 200000u);
        settle_one_bit(TIM1_BASE);
        g_tim1_dma_waited = true;
    }
    (void)motor;
}

static void note_edge(unsigned motor, uint32_t ccr)
{
    ic_motor_t *m = &g_m[motor];
    if (m->have_prev && m->buf && m->n < m->cap) {
        uint16_t delta = (uint16_t)((ccr - m->prev_ccr) & 0xFFFFu);
        m->buf[m->n++] = delta == 0u ? 1u : delta;
    }
    m->prev_ccr = ccr;
    m->have_prev = true;
}

static void finish_motor_collect(unsigned motor)
{
    ic_motor_t *m = &g_m[motor];
    if (!m->armed && !m->in_ic) {
        return;
    }
    m->armed = false;
    m->collected = true;
    if (m->in_ic) {
        restore_channel_pwm(motor);
    }
}

static void maybe_clear_dma_wait_flags(void)
{
    if (!g_m[0].in_ic && !g_m[1].in_ic) {
        g_tim3_dma_waited = false;
    }
    if (!g_m[2].in_ic && !g_m[3].in_ic) {
        g_tim1_dma_waited = false;
    }
}

bool hal_dshot_ic_arm(unsigned motor, uint16_t *edge_buf, size_t cap)
{
    ic_motor_t *m;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT || !edge_buf || cap == 0u || !kakute_ok()) {
        return false;
    }
    m = &g_m[motor];
    m->buf = edge_buf;
    m->cap = cap > HAL_DSHOT_IC_MAX_EDGES ? HAL_DSHOT_IC_MAX_EDGES : cap;
    m->n = 0u;
    m->armed = true;
    m->collected = false;

    ensure_dma_waited(motor);
    program_channel_ic(motor);
    R(motor_tim(motor), 0x00) |= 1u;
    return true;
}

void hal_dshot_ic_collect(void)
{
    unsigned spins = IC_SPIN_BUDGET;
    unsigned quiet = 0u;
    unsigned motor;
    bool any = false;

    for (motor = 0u; motor < HAL_DSHOT_IC_MOTOR_COUNT; motor++) {
        if (g_m[motor].armed && g_m[motor].in_ic) {
            any = true;
            break;
        }
    }
    if (!any) {
        return;
    }

    while (spins--) {
        bool saw = false;
        bool full = true;
        for (motor = 0u; motor < HAL_DSHOT_IC_MOTOR_COUNT; motor++) {
            ic_motor_t *m = &g_m[motor];
            uintptr_t t;
            unsigned ch;
            uint32_t ccif;
            if (!m->armed || !m->in_ic) {
                continue;
            }
            if (m->n < m->cap) {
                full = false;
            }
            t = motor_tim(motor);
            ch = motor_ch(motor);
            ccif = 1u << ch;
            if (R(t, 0x10) & ccif) {
                uint32_t ccr = channel_ccr(t, ch);
                R(t, 0x10) = ccif;
                note_edge(motor, ccr);
                saw = true;
            }
        }
        if (full) {
            break;
        }
        if (saw) {
            quiet = 0u;
        } else {
            /* Only start quiet timer after at least one edge on any line. */
            bool any_edge = false;
            for (motor = 0u; motor < HAL_DSHOT_IC_MOTOR_COUNT; motor++) {
                if (g_m[motor].have_prev) {
                    any_edge = true;
                    break;
                }
            }
            if (any_edge) {
                quiet++;
                if (quiet >= IC_QUIET_GAP) {
                    break;
                }
            }
        }
    }

    for (motor = 0u; motor < HAL_DSHOT_IC_MOTOR_COUNT; motor++) {
        if (g_m[motor].armed || g_m[motor].in_ic) {
            finish_motor_collect(motor);
        }
    }
    maybe_clear_dma_wait_flags();
}

size_t hal_dshot_ic_take(unsigned motor)
{
    ic_motor_t *m;
    uintptr_t t;
    unsigned ch;
    unsigned spins;
    unsigned quiet;
    uint32_t ccif;

    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return 0u;
    }
    m = &g_m[motor];

    /* After parallel collect(): edges already buffered. */
    if (m->collected) {
        size_t n = m->n;
        m->collected = false;
        m->armed = false;
        return n;
    }

    if (!m->armed) {
        return 0u;
    }
    m->armed = false;

    if (!m->in_ic) {
        return 0u;
    }

    /* Solo path (single-motor arm/poll, host-style). */
    t = motor_tim(motor);
    ch = motor_ch(motor);
    ccif = 1u << ch;
    spins = IC_SPIN_BUDGET;
    quiet = 0u;
    while (spins-- && m->n < m->cap) {
        if (R(t, 0x10) & ccif) {
            uint32_t ccr = channel_ccr(t, ch);
            R(t, 0x10) = ccif;
            note_edge(motor, ccr);
            quiet = 0u;
        } else if (m->have_prev) {
            quiet++;
            if (quiet >= IC_QUIET_GAP) {
                break;
            }
        }
    }

    restore_channel_pwm(motor);
    maybe_clear_dma_wait_flags();
    return m->n;
}

void hal_dshot_ic_cancel(unsigned motor)
{
    ic_motor_t *m;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return;
    }
    m = &g_m[motor];
    m->armed = false;
    m->collected = false;
    m->n = 0u;
    m->buf = NULL;
    m->cap = 0u;
    m->have_prev = false;
    if (m->in_ic) {
        restore_channel_pwm(motor);
    }
    maybe_clear_dma_wait_flags();
}

void hal_dshot_ic_cancel_all(void)
{
    unsigned i;
    for (i = 0u; i < HAL_DSHOT_IC_MOTOR_COUNT; i++) {
        hal_dshot_ic_cancel(i);
    }
    g_tim3_dma_waited = false;
    g_tim1_dma_waited = false;
}

uint16_t hal_dshot_ic_bit_period_ticks(unsigned motor)
{
    uintptr_t t;
    uint32_t arr;
    uint32_t dshot_ticks;
    uint32_t telem;

    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return 1u;
    }
    t = motor_tim(motor);
    arr = R(t, 0x2C);
    dshot_ticks = arr + 1u;
    telem = (dshot_ticks * 4u) / 5u;
    if (telem == 0u) {
        telem = 1u;
    }
    if (telem > 0xFFFFu) {
        telem = 0xFFFFu;
    }
    return (uint16_t)telem;
}
