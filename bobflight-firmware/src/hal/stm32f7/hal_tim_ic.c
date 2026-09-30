/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Kakute F7 HDV M1–M4 bidirectional DShot receive: DMA input capture (B2).
 *
 * Pins / TX (IR lock, ir_verified=false — unchanged, no remap):
 *   M1 PB0 AF2 TIM3_CH3 | M2 PB1 AF2 TIM3_CH4 — TX TIM3_UP DMA1 S2/C5
 *   M3 PE9 AF1 TIM1_CH1 | M4 PE11 AF1 TIM1_CH2 — TX TIM1_UP DMA2 S5/C6
 *
 * Capture DMA, from the RM0385 (STM32F74x/75x) "DMA1 request mapping" and
 * "DMA2 request mapping" tables (§8.3.3; Table 27/28 — same rows in RM0410
 * and RM0431):
 *   M1 TIM3_CH3  DMA1 Stream7 Channel5
 *   M2 TIM3_CH4  DMA1 Stream2 Channel5  (request is "TIM3_CH4/TIM3_UP": the
 *                SAME stream as TX. Reused only after the TX transfer
 *                completed, with UDE cleared so updates cannot trigger it.)
 *   M3 TIM1_CH1  DMA2 Stream1 Channel6  (S3/C6 also maps TIM1_CH1 but S3 is
 *                SPI1_TX's only free stream — S5 is TIM1_UP — so S1 keeps the
 *                SD card's DMA option open)
 *   M4 TIM1_CH2  DMA2 Stream2 Channel6  (only TIM1_CH2-only stream; S6/C0 is
 *                the ORed TIM1_CH1/CH2/CH3 request and cannot be shared with
 *                a separate CH1 capture)
 * Today SPI4 (gyro), SPI1 (SD), USART6 (CRSF) and ADC are polled/IRQ-driven
 * and use no DMA, so none of these streams is in use. See
 * docs/DSHOT-BIDIR-4K.md for the streams each choice takes away.
 *
 * Sequence (nothing here waits for the frame or the reply):
 *   arm      (main loop, before TX)  record buffers; group state ARMED.
 *            hal_tim_dma_start_burst() then sets TCIE on the TX stream.
 *   TX TC IRQ (~19 bit periods after TX start, after the last data bit):
 *            UDE off, ARR=0xFFFF (free-running 16-bit timebase), channel ->
 *            input capture both edges, capture DMA on; state CAPTURING.
 *   collect  (main loop, next cycle, before the next TX): capture DMA off,
 *            channels back to PWM, ARR restored; timestamps copied out.
 * If the harvest finds the group still ARMED the TX frame never completed:
 * HAL_DSHOT_IC_TX_NOT_DONE (a capture failure, not ESC silence).
 */
#include "hal_f7_priv.h"
#include "board/board.h"
#include "hal/hal.h"
#include "hal/dshot_ic_tail.h"

#include <string.h>

#ifndef R
#define R(base, offset) (*(volatile uint32_t *)((uintptr_t)(base) + (offset)))
#endif

#define TIM3_BASE   0x40000400u
#define TIM1_BASE   0x40010000u
#define DMA1_BASE   0x40026000u
#define DMA2_BASE   0x40026400u

/* TIM register offsets / bits (RM0385 TIM1 / TIM2-5 register maps). */
#define TIM_CR1   0x00u
#define TIM_DIER  0x0Cu
#define TIM_SR    0x10u
#define IC_TIM_SR_UIF 0x1u
#define TIM_CCMR1 0x18u
#define TIM_CCMR2 0x1Cu
#define TIM_CCER  0x20u
#define TIM_CNT   0x24u
#define TIM_ARR   0x2Cu
#define TIM_CCR1  0x34u
#define TIM_CR1_ARPE (1u << 7)
#define TIM_DIER_UDE (1u << 8)
#define TIM_DIER_CCDE(ch) (1u << (8u + (ch)))
/* Input capture byte: CCxS=01 (ICx on TIx), no prescaler, ICxF=0011
 * (fCK_INT, N=8: 74 ns at 108 MHz, 37 ns at 216 MHz — far below a
 * 1.33 us DShot600 telemetry bit). */
#define IC_CCMR_BYTE 0x31u
/* CCxE | CCxP | CCxNP: capture both edges. */
#define IC_CCER_NIBBLE 0xBu

/* DMA stream registers (RM0385 DMA register map). */
#define DMA_SxCR   0x00u
#define DMA_SxNDTR 0x04u
#define DMA_SxPAR  0x08u
#define DMA_SxM0AR 0x0Cu
#define DMA_SxFCR  0x14u
#define DMA_CR_EN   (1u << 0)
#define DMA_CR_TCIE (1u << 4)
#define DMA_CR_MINC (1u << 10)
#define DMA_CR_PSIZE16 (1u << 11)
#define DMA_CR_MSIZE16 (1u << 13)
#define DMA_CR_PL_HIGH (2u << 16)
#define DMA_CR_CHSEL(c) ((uint32_t)(c) << 25)
#define DMA_FLAG_FE  (1u << 0)
#define DMA_FLAG_DME (1u << 2)
#define DMA_FLAG_TE  (1u << 3)
#define DMA_FLAG_ALL 0x3Du
#define DMA_STOP_SPINS 64u /* EN clears within a few AHB cycles */

/* IRQ numbers (RM0385 vector table): DMA1_Stream2 = 13, DMA2_Stream5 = 68. */
#define IRQ_DMA1_S2 13u
#define IRQ_DMA2_S5 68u
#define IRQ_PRIO_DSHOT 1u /* above UART (2) and USB (5); SysTick stays 0 */

enum { GROUP_TIM3 = 0, GROUP_TIM1 = 1, GROUP_COUNT = 2 };
enum { ST_IDLE = 0, ST_ARMED, ST_CAPTURING };

typedef struct {
    uintptr_t tim;
    unsigned ch;       /* timer channel 1..4 */
    uintptr_t dma;
    unsigned stream;
    unsigned chsel;
    unsigned group;
} ic_route_t;

/* Motor index 0..3 = M1..M4. */
static const ic_route_t k_route[HAL_DSHOT_IC_MOTOR_COUNT] = {
    {TIM3_BASE, 3u, DMA1_BASE, 7u, 5u, GROUP_TIM3}, /* M1 TIM3_CH3 DMA1 S7/C5 */
    {TIM3_BASE, 4u, DMA1_BASE, 2u, 5u, GROUP_TIM3}, /* M2 TIM3_CH4 DMA1 S2/C5 */
    {TIM1_BASE, 1u, DMA2_BASE, 1u, 6u, GROUP_TIM1}, /* M3 TIM1_CH1 DMA2 S1/C6 */
    {TIM1_BASE, 2u, DMA2_BASE, 2u, 6u, GROUP_TIM1}, /* M4 TIM1_CH2 DMA2 S2/C6 */
};

typedef struct {
    uint16_t *out;
    size_t cap;
    size_t n;
    bool armed;
    bool harvested;
    bool in_ic;
    uint8_t saved_ccmr_byte;
    uint8_t saved_ccer_nibble;
    uint16_t tail;
    uint16_t bit_ticks;
    hal_dshot_ic_result_t result;
} ic_motor_t;

typedef struct {
    volatile uint8_t state;
    uint32_t saved_arr;
    uint16_t cnt_open;   /* CNT right after ARR = 0xFFFF (wrap disambiguation) */
} ic_group_t;

static ic_motor_t g_m[HAL_DSHOT_IC_MOTOR_COUNT];
static ic_group_t g_g[GROUP_COUNT];
static bool g_irq_ready;
/* DMA-capable SRAM1/2 (not DTCM); 128 B each = 4 cache lines. */
static uint16_t g_cap[HAL_DSHOT_IC_MOTOR_COUNT][HAL_DSHOT_IC_MAX_EDGES]
    __attribute__((section(".dma"), aligned(32)));

static uintptr_t stream_base(uintptr_t dma, unsigned stream)
{
    return dma + 0x10u + 0x18u * stream;
}
static unsigned flag_shift(unsigned stream)
{
    static const unsigned sh[4] = {0u, 6u, 16u, 22u};
    return sh[stream & 3u];
}
static uint32_t dma_flags(uintptr_t dma, unsigned stream)
{
    return (R(dma, stream < 4u ? 0x00u : 0x04u) >> flag_shift(stream)) & DMA_FLAG_ALL;
}
static void dma_clear_flags(uintptr_t dma, unsigned stream)
{
    R(dma, stream < 4u ? 0x08u : 0x0Cu) = DMA_FLAG_ALL << flag_shift(stream);
}

static uint32_t irq_save(void)
{
    uint32_t pm;
    __asm volatile("mrs %0, primask" : "=r"(pm));
    __asm volatile("cpsid i" ::: "memory");
    return pm;
}
static void irq_restore(uint32_t pm)
{
    __asm volatile("msr primask, %0" ::"r"(pm) : "memory");
}

static bool kakute_ok(void)
{
    const board_t *b = board_get();
    return b && board_mmio_permitted() &&
           strcmp(b->board_id, "kakute_f7_hdv") == 0;
}

static void nvic_enable(unsigned irq)
{
    R(0xE000E400u, irq & ~3u) = (R(0xE000E400u, irq & ~3u) & ~(0xFFu << ((irq & 3u) * 8u))) |
                               ((IRQ_PRIO_DSHOT << 4) << ((irq & 3u) * 8u));
    R(0xE000E280u, (irq / 32u) * 4u) = 1u << (irq % 32u); /* clear pending */
    R(0xE000E100u, (irq / 32u) * 4u) = 1u << (irq % 32u); /* enable */
}

static uint32_t ccmr_off(unsigned ch) { return ch <= 2u ? TIM_CCMR1 : TIM_CCMR2; }
static unsigned ccmr_shift(unsigned ch) { return (ch == 1u || ch == 3u) ? 0u : 8u; }

/* IRQ context: TX frame done for this group → open the capture window. */
static void group_open_window(unsigned group)
{
    uintptr_t t = group == GROUP_TIM3 ? TIM3_BASE : TIM1_BASE;
    uint32_t dier = 0u;
    unsigned motor;

    if (g_g[group].state != ST_ARMED) {
        return;
    }
    R(t, TIM_DIER) = 0u;                 /* UDE off first: TIM3_UP shares S2 */
    g_g[group].saved_arr = R(t, TIM_ARR);
    R(t, TIM_CR1) &= ~TIM_CR1_ARPE;
    R(t, TIM_ARR) = 0xFFFFu;             /* free-running 16-bit timestamps */
    g_g[group].cnt_open = (uint16_t)R(t, TIM_CNT);
    R(t, TIM_SR) = ~IC_TIM_SR_UIF;          /* UIF from here on = counter wrapped */

    for (motor = 0u; motor < HAL_DSHOT_IC_MOTOR_COUNT; motor++) {
        const ic_route_t *r = &k_route[motor];
        ic_motor_t *m = &g_m[motor];
        uintptr_t s;
        uint32_t ccer, ccmr;
        unsigned sh = (r->ch - 1u) * 4u;
        if (r->group != group || !m->armed) {
            continue;
        }
        m->bit_ticks = (uint16_t)(((g_g[group].saved_arr + 1u) * 4u) / 5u);
        /* CCxS is writable only with CCxE = 0. */
        ccer = R(t, TIM_CCER);
        m->saved_ccer_nibble = (uint8_t)((ccer >> sh) & 0xFu);
        R(t, TIM_CCER) = ccer & ~(0xFu << sh);
        ccmr = R(t, ccmr_off(r->ch));
        m->saved_ccmr_byte = (uint8_t)((ccmr >> ccmr_shift(r->ch)) & 0xFFu);
        ccmr = (ccmr & ~(0xFFu << ccmr_shift(r->ch))) | (IC_CCMR_BYTE << ccmr_shift(r->ch));
        R(t, ccmr_off(r->ch)) = ccmr;
        R(t, TIM_CCER) = (R(t, TIM_CCER) & ~(0xFu << sh)) | (IC_CCER_NIBBLE << sh);
        R(t, TIM_SR) = ~(1u << r->ch);   /* drop any stale CCxIF */
        m->in_ic = true;

        s = stream_base(r->dma, r->stream);
        R(s, DMA_SxCR) = 0u;             /* TX stream is already off after TC */
        dma_clear_flags(r->dma, r->stream);
        R(s, DMA_SxPAR) = (uint32_t)(t + TIM_CCR1 + (r->ch - 1u) * 4u);
        R(s, DMA_SxM0AR) = (uint32_t)(uintptr_t)&g_cap[motor][0];
        R(s, DMA_SxNDTR) = (uint32_t)m->cap;
        R(s, DMA_SxFCR) = 0u;            /* direct mode */
        R(s, DMA_SxCR) = DMA_CR_CHSEL(r->chsel) | DMA_CR_PL_HIGH | DMA_CR_MSIZE16 |
                         DMA_CR_PSIZE16 | DMA_CR_MINC | DMA_CR_EN; /* P2M */
        dier |= TIM_DIER_CCDE(r->ch);
    }
    R(t, TIM_DIER) = dier;
    g_g[group].state = ST_CAPTURING;
}

void DMA1_Stream2_IRQHandler(void)
{
    const uint32_t tc = 1u << (5u + flag_shift(2u));
    if (R(DMA1_BASE, 0x00u) & tc) {
        R(DMA1_BASE, 0x08u) = tc;
        group_open_window(GROUP_TIM3);
    }
}

void DMA2_Stream5_IRQHandler(void)
{
    const uint32_t tc = 1u << (5u + flag_shift(5u));
    if (R(DMA2_BASE, 0x04u) & tc) {
        R(DMA2_BASE, 0x0Cu) = tc;
        group_open_window(GROUP_TIM1);
    }
}

static void restore_channel(unsigned motor)
{
    const ic_route_t *r = &k_route[motor];
    ic_motor_t *m = &g_m[motor];
    unsigned sh = (r->ch - 1u) * 4u;
    uint32_t ccmr;
    if (!m->in_ic) {
        return;
    }
    R(r->tim, TIM_CCER) &= ~(0xFu << sh);
    ccmr = R(r->tim, ccmr_off(r->ch));
    ccmr = (ccmr & ~(0xFFu << ccmr_shift(r->ch))) |
           ((uint32_t)m->saved_ccmr_byte << ccmr_shift(r->ch));
    R(r->tim, ccmr_off(r->ch)) = ccmr;
    R(r->tim, TIM_CCER) = (R(r->tim, TIM_CCER) & ~(0xFu << sh)) |
                          ((uint32_t)m->saved_ccer_nibble << sh);
    m->in_ic = false;
}

/* Main-loop context, bounded: never waits for edges. */
static void harvest_group(unsigned group)
{
    uintptr_t t = group == GROUP_TIM3 ? TIM3_BASE : TIM1_BASE;
    uint32_t pm = irq_save();
    const uint8_t st = g_g[group].state;
    uint32_t sr = 0u;
    uint16_t cnt_now = 0u;
    unsigned motor;

    if (st == ST_CAPTURING) {
        /* 1) Stop requests and streams for the whole group (bounded spin on
         *    EN, a few AHB cycles), then 2) sample CNT so tail_ticks can
         *    only under-estimate the quiet time. */
        R(t, TIM_DIER) = 0u;
        for (motor = 0u; motor < HAL_DSHOT_IC_MOTOR_COUNT; motor++) {
            const ic_route_t *r = &k_route[motor];
            uintptr_t s = stream_base(r->dma, r->stream);
            unsigned spins = DMA_STOP_SPINS;
            if (r->group != group || !g_m[motor].armed) {
                continue;
            }
            R(s, DMA_SxCR) &= ~DMA_CR_EN;
            while ((R(s, DMA_SxCR) & DMA_CR_EN) && spins) {
                spins--;
            }
        }
        cnt_now = (uint16_t)R(t, TIM_CNT);
        sr = R(t, TIM_SR); /* CCxIF still set = an edge the DMA did not take */
    }

    for (motor = 0u; motor < HAL_DSHOT_IC_MOTOR_COUNT; motor++) {
        const ic_route_t *r = &k_route[motor];
        ic_motor_t *m = &g_m[motor];
        uintptr_t s = stream_base(r->dma, r->stream);
        if (r->group != group || !m->armed) {
            continue;
        }
        m->armed = false;
        m->harvested = true;
        m->n = 0u;
        m->tail = HAL_DSHOT_IC_TAIL_QUIET;
        if (st == ST_ARMED) {
            m->result = HAL_DSHOT_IC_TX_NOT_DONE; /* window never opened */
            continue;
        }
        if (st != ST_CAPTURING) {
            m->result = HAL_DSHOT_IC_NOT_ARMED;
            continue;
        }
        if ((R(s, DMA_SxCR) & DMA_CR_EN) ||
            (dma_flags(r->dma, r->stream) & (DMA_FLAG_TE | DMA_FLAG_DME))) {
            m->result = HAL_DSHOT_IC_DMA_ERROR;
        } else {
            uint32_t left = R(s, DMA_SxNDTR) & 0xFFFFu;
            m->result = HAL_DSHOT_IC_OK;
            m->n = left <= m->cap ? m->cap - left : 0u;
        }
        dma_clear_flags(r->dma, r->stream);
        restore_channel(motor);
        if (m->result == HAL_DSHOT_IC_OK && m->n > 0u) {
            size_t i;
#if defined(BOBFLIGHT_HAVE_CMSIS)
            if (SCB->CCR & SCB_CCR_DC_Msk) {
                SCB_InvalidateDCache_by_Addr((void *)&g_cap[motor][0], (int32_t)sizeof(g_cap[motor]));
            }
#endif
            for (i = 0u; i < m->n; i++) {
                m->out[i] = g_cap[motor][i];
            }
            m->tail = dshot_ic_tail_ticks(g_g[group].cnt_open, g_cap[motor][m->n - 1u], cnt_now,
                                          (sr & IC_TIM_SR_UIF) != 0u, (sr & (1u << r->ch)) != 0u);
        }
    }
    if (st == ST_CAPTURING) {
        R(t, TIM_SR) = 0u;
        R(t, TIM_ARR) = g_g[group].saved_arr;
        R(t, TIM_CR1) |= TIM_CR1_ARPE;
    }
    g_g[group].state = ST_IDLE;
    irq_restore(pm);
}

bool hal_f7_dshot_ic_tc_irq_wanted(unsigned group)
{
    return group < GROUP_COUNT && g_g[group].state == ST_ARMED;
}

void hal_f7_dshot_ic_quiesce(unsigned group)
{
    if (group < GROUP_COUNT && g_g[group].state == ST_CAPTURING) {
        harvest_group(group);
    }
}

bool hal_dshot_ic_arm(unsigned motor, uint16_t *edge_buf, size_t cap)
{
    ic_motor_t *m;
    unsigned group;
    uint32_t pm;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT || !edge_buf || cap < 2u || !kakute_ok()) {
        if (motor < HAL_DSHOT_IC_MOTOR_COUNT) {
            g_m[motor].result = HAL_DSHOT_IC_NO_HW;
        }
        return false;
    }
    group = k_route[motor].group;
    if (g_g[group].state == ST_CAPTURING) {
        harvest_group(group); /* never overlap a window with a new frame */
    }
    if (!g_irq_ready) {
        nvic_enable(IRQ_DMA1_S2);
        nvic_enable(IRQ_DMA2_S5);
        g_irq_ready = true;
    }
    pm = irq_save();
    m = &g_m[motor];
    m->out = edge_buf;
    m->cap = cap > HAL_DSHOT_IC_MAX_EDGES ? HAL_DSHOT_IC_MAX_EDGES : cap;
    m->n = 0u;
    m->harvested = false;
    m->result = HAL_DSHOT_IC_OK;
    m->tail = HAL_DSHOT_IC_TAIL_QUIET;
    m->armed = true;
    g_g[group].state = ST_ARMED;
    irq_restore(pm);
    return true;
}

void hal_dshot_ic_collect(void)
{
    unsigned g;
    for (g = 0u; g < GROUP_COUNT; g++) {
        if (g_g[g].state != ST_IDLE) {
            harvest_group(g);
        }
    }
}

size_t hal_dshot_ic_take(unsigned motor)
{
    ic_motor_t *m;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return 0u;
    }
    m = &g_m[motor];
    if (m->armed) {
        harvest_group(k_route[motor].group);
    }
    if (!m->harvested) {
        if (m->result == HAL_DSHOT_IC_OK) {
            m->result = HAL_DSHOT_IC_NOT_ARMED;
        }
        return 0u;
    }
    m->harvested = false;
    return m->result == HAL_DSHOT_IC_OK ? m->n : 0u;
}

hal_dshot_ic_result_t hal_dshot_ic_result(unsigned motor)
{
    return motor < HAL_DSHOT_IC_MOTOR_COUNT ? g_m[motor].result : HAL_DSHOT_IC_NOT_ARMED;
}

uint16_t hal_dshot_ic_tail_ticks(unsigned motor)
{
    return motor < HAL_DSHOT_IC_MOTOR_COUNT ? g_m[motor].tail : HAL_DSHOT_IC_TAIL_QUIET;
}

void hal_dshot_ic_cancel(unsigned motor)
{
    unsigned group;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return;
    }
    group = k_route[motor].group;
    if (g_g[group].state != ST_IDLE && kakute_ok()) {
        harvest_group(group); /* stops DMA, restores PWM + ARR */
    }
    g_m[motor].armed = false;
    g_m[motor].harvested = false;
    g_m[motor].n = 0u;
    g_m[motor].out = NULL;
    g_m[motor].cap = 0u;
}

void hal_dshot_ic_cancel_all(void)
{
    unsigned i;
    for (i = 0u; i < HAL_DSHOT_IC_MOTOR_COUNT; i++) {
        hal_dshot_ic_cancel(i);
    }
}

uint16_t hal_dshot_ic_bit_period_ticks(unsigned motor)
{
    uint32_t arr;
    uint32_t telem;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return 1u;
    }
    if (g_m[motor].bit_ticks) {
        return g_m[motor].bit_ticks; /* from the TX ARR saved at the switch */
    }
    if (!kakute_ok()) {
        return 1u;
    }
    arr = R(k_route[motor].tim, TIM_ARR);
    telem = ((arr + 1u) * 4u) / 5u;
    if (telem == 0u) telem = 1u;
    if (telem > 0xFFFFu) telem = 0xFFFFu;
    return (uint16_t)telem;
}
