/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * B2 host tests: bidirectional DShot eRPM with the non-blocking DMA capture
 * pipeline at a 4 kHz loop (and the 1 kHz fallback).
 *
 * The HAL here is a TIMELINE SIMULATOR of the MCU contract in hal/hal.h:
 * arm() stamps the TX start, the capture window opens at the TX DMA TC
 * (dshot_bidir_budget.h), a modelled ESC drives inverted-idle GCR edges
 * after its turnaround, and collect() at the next cycle keeps only edges
 * that happened before the harvest, as 16-bit timer timestamps (108 MHz
 * TIM3 for M1/M2, 216 MHz TIM1 for M3/M4). No hardware claim: it proves
 * the driver/decoder/state machine/policy against the documented budget.
 *
 * Covers: GCR decode from capture buffers (valid, noisy, truncated, wrong
 * CRC, unterminated last run, timer wrap, pre-frame glitch); per-motor
 * state machine across loop iterations at 4 kHz and 1 kHz (one-cycle
 * pipeline lag, independent motors); no-block guarantee with no reply;
 * fallback latch on repeated capture failure; loop-rate interplay with #57
 * (loop_rate_select on the live driver state).
 */
#include "drivers/dshot.h"
#include "drivers/dshot_gcr.h"
#include "drivers/dshot_telem.h"
#include "drivers/dshot_bidir_budget.h"
#include "sched/loop_rate.h"
#include "sched/scheduler.h"
#include "drivers/gyro.h"
#include "board/board.h"
#include "hal/hal.h"
#include "hal/dshot_ic_tail.h"
#include "flight/arming.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

/* ---------------- link stubs (dshot.c / loop_rate.c) ---------------- */
bool bench_motor_active(void) { return false; }
arm_state_t arming_state(void) { return ARM_DISARMED; }
void arming_disarm(void) {}
const board_t *board_get(void) { return NULL; }
bool board_pins_live(void) { return false; }
bool board_mmio_permitted(void) { return false; }
hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *cfg) { (void)cfg; return NULL; }
bool hal_tim_dma_start_burst(hal_tim_dma_t *t, const uint16_t *w, size_t n) { (void)t; (void)w; (void)n; return false; }
bool hal_tim_dma_set_bit_rate(uint32_t hz) { return hz == 300000u || hz == 600000u; }
void hal_gpio_init(hal_pin_t pin, hal_gpio_mode_t mode) { (void)pin; (void)mode; }
void hal_gpio_write(hal_pin_t pin, bool high) { (void)pin; (void)high; }
static bool g_inverted;
void hal_tim_dma_set_inverted(bool inverted) { g_inverted = inverted; }
/* loop_rate.c dependencies (policy is exercised through loop_rate_select). */
static scheduler_stats_t g_sched;
const scheduler_stats_t *scheduler_stats(void) { return &g_sched; }
void scheduler_init(uint32_t g, uint32_t d) { g_sched.gyro_hz = g; g_sched.pid_process_denom = d; }
void scheduler_set_rate(uint32_t g, uint32_t d) { scheduler_init(g, d); }
uint32_t scheduler_loop_target_hz(void) { return g_sched.pid_process_denom ? g_sched.gyro_hz / g_sched.pid_process_denom : 0u; }
static gyro_diagnostics_t g_diag;
const gyro_diagnostics_t *gyro_diagnostics(void) { return &g_diag; }
bool gyro_is_healthy(void) { return true; }
bool hal_time_high_resolution(void) { return true; }
uint32_t loop_rate_setting_get(void) { return 4000u; }

/* ---------------- simulated time ---------------- */
static uint64_t g_now_ns;
static uint32_t g_ms_override;
uint32_t hal_millis(void) { return g_ms_override ? g_ms_override : (uint32_t)(g_now_ns / 1000000u); }

/* ---------------- ESC + capture timeline simulator ---------------- */
typedef struct {
    uint32_t period_us;     /* eRPM period the ESC reports; 0 = silent */
    bool corrupt_crc;
    bool glitch;            /* one sub-bit spike in the middle of the reply */
} esc_t;

typedef struct {
    uint16_t *buf;
    size_t cap;
    bool armed;
    uint64_t tx_ns;
    esc_t esc_at_tx;        /* what the ESC answers to THIS frame */
    size_t n;
    uint16_t tail;
    hal_dshot_ic_result_t result;
    bool harvested;
    hal_dshot_ic_result_t force;
} sim_motor_t;

static esc_t g_esc[4];
static sim_motor_t g_sim[4];
static unsigned g_kbps = 300u;
static uint32_t g_turnaround_ns = DSHOT_BIDIR_TURNAROUND_NOM_NS;
static uint32_t g_edge_jitter_ns;
static unsigned g_collect_calls, g_take_calls;
static uint16_t g_tick_base[4] = {65000u, 123u, 40000u, 65535u};

static uint32_t timer_mhz(unsigned m) { return m < 2u ? 108u : 216u; }
/* Absolute (un-wrapped) capture-timer count; the 16-bit CNT is its low half. */
static uint64_t abs_ticks(unsigned m, uint64_t ns)
{
    return (uint64_t)g_tick_base[m] + (ns * timer_mhz(m)) / 1000u;
}
static uint16_t to_ticks(unsigned m, uint64_t ns) { return (uint16_t)abs_ticks(m, ns); }
/* Hardware-faithful counter (default): the TX fire writes CNT = 0, the timer
 * wraps at ARR (one DShot bit) during the frame, and at the TX TC the IC
 * window sets ARR = 0xFFFF, so CNT at window open is < one bit period and the
 * counter then free-runs (TIM1 wraps every ~302 us — several times inside a
 * 1 kHz period). g_hw_cnt = false uses g_tick_base instead, so the decoder
 * also sees timestamps wrapping inside a reply. */
static bool g_hw_cnt = true;
static uint64_t frame_ticks(unsigned m, uint64_t tx_ns, uint64_t live_ns, uint64_t ns)
{
    const uint64_t mhz = timer_mhz(m);
    const uint64_t arr1 = mhz * 1000u / g_kbps;
    const uint64_t open = (((live_ns - tx_ns) * mhz) / 1000u) % arr1;
    if (!g_hw_cnt) return abs_ticks(m, ns);
    return open + ((ns - live_ns) * mhz) / 1000u;
}
uint16_t hal_dshot_ic_bit_period_ticks(unsigned m)
{
    uint32_t arr1 = timer_mhz(m) * 1000u / g_kbps; /* TX ticks per bit */
    return (uint16_t)(arr1 * 4u / 5u);
}
static uint32_t rnd(void)
{
    static uint32_t x = 2463534242u;
    x ^= x << 13; x ^= x >> 17; x ^= x << 5;
    return x;
}

bool hal_dshot_ic_arm(unsigned m, uint16_t *buf, size_t cap)
{
    if (m >= 4u || !buf || cap < 2u) return false;
    g_sim[m].buf = buf;
    g_sim[m].cap = cap;
    g_sim[m].armed = true;
    g_sim[m].harvested = false;
    g_sim[m].tx_ns = g_now_ns;       /* bursts fire right after arm */
    g_sim[m].esc_at_tx = g_esc[m];
    return true;
}

/* Build the ESC's edge times (ns from TX start) for one reply. */
static size_t esc_edges(const esc_t *e, uint64_t *t, size_t cap)
{
    uint16_t payload;
    uint32_t wire;
    const uint64_t bit = dshot_bidir_reply_bit_ns(g_kbps);
    const uint64_t t0 = dshot_bidir_frame_end_ns(g_kbps) + g_turnaround_ns;
    unsigned prev = 1u; /* idle high (inverted line, pull-up) */
    unsigned i;
    size_t n = 0u;
    if (!e->period_us) return 0u;
    payload = dshot_gcr_pack_payload(dshot_gcr_pack_period12(e->period_us));
    if (e->corrupt_crc) payload ^= 0x0001u;
    wire = dshot_gcr_encode_21(payload);
    for (i = 0u; i < 21u; i++) {
        unsigned lvl = (unsigned)((wire >> (20u - i)) & 1u); /* 0 = low */
        if (lvl != prev && n < cap) {
            int64_t j = g_edge_jitter_ns ? (int64_t)(rnd() % (2u * g_edge_jitter_ns + 1u)) - (int64_t)g_edge_jitter_ns : 0;
            t[n++] = (uint64_t)((int64_t)(t0 + i * bit) + (i ? j : 0));
        }
        prev = lvl;
        if (e->glitch && i == 10u && n + 2u <= cap) {
            t[n++] = t0 + i * bit + bit / 4u;       /* 1/4-bit spike */
            t[n++] = t0 + i * bit + bit / 4u + 200u;
        }
    }
    if (prev == 0u && n < cap) t[n++] = t0 + 21u * bit; /* back to idle high */
    return n;
}

static void harvest_motor(unsigned m)
{
    sim_motor_t *s = &g_sim[m];
    uint64_t t[80];
    size_t ne, i;
    const uint64_t live = s->tx_ns + dshot_bidir_capture_live_ns(g_kbps);
    if (!s->armed) return;
    s->armed = false;
    s->harvested = true;
    s->n = 0u;
    s->tail = HAL_DSHOT_IC_TAIL_QUIET;
    if (s->force != HAL_DSHOT_IC_OK) { s->result = s->force; return; }
    if (g_now_ns < live) { s->result = HAL_DSHOT_IC_TX_NOT_DONE; return; }
    s->result = HAL_DSHOT_IC_OK;
    ne = esc_edges(&s->esc_at_tx, t, 80u);
    for (i = 0u; i < ne && s->n < s->cap; i++) {
        uint64_t abs_ns = s->tx_ns + t[i];
        if (abs_ns < live || abs_ns >= g_now_ns) continue; /* outside the window */
        s->buf[s->n++] = (uint16_t)frame_ticks(m, s->tx_ns, live, abs_ns);
    }
    if (s->n) {
        /* Same tail rule as the F7 HAL: CNT at window open + UIF (wrapped). */
        const uint64_t t_open = frame_ticks(m, s->tx_ns, live, live);
        const uint64_t t_now = frame_ticks(m, s->tx_ns, live, g_now_ns);
        s->tail = dshot_ic_tail_ticks((uint16_t)t_open, s->buf[s->n - 1u], (uint16_t)t_now,
                                      (t_now >> 16) != (t_open >> 16), false);
    }
}

void hal_dshot_ic_collect(void)
{
    unsigned m;
    g_collect_calls++;
    for (m = 0u; m < 4u; m++) harvest_motor(m);
}
size_t hal_dshot_ic_take(unsigned m)
{
    g_take_calls++;
    if (m >= 4u) return 0u;
    if (g_sim[m].armed) harvest_motor(m);
    if (!g_sim[m].harvested) { g_sim[m].result = HAL_DSHOT_IC_NOT_ARMED; return 0u; }
    g_sim[m].harvested = false;
    return g_sim[m].result == HAL_DSHOT_IC_OK ? g_sim[m].n : 0u;
}
hal_dshot_ic_result_t hal_dshot_ic_result(unsigned m) { return m < 4u ? g_sim[m].result : HAL_DSHOT_IC_NOT_ARMED; }
uint16_t hal_dshot_ic_tail_ticks(unsigned m) { return m < 4u ? g_sim[m].tail : HAL_DSHOT_IC_TAIL_QUIET; }
void hal_dshot_ic_cancel(unsigned m) { if (m < 4u) { g_sim[m].armed = false; g_sim[m].harvested = false; } }
void hal_dshot_ic_cancel_all(void) { unsigned m; for (m = 0u; m < 4u; m++) hal_dshot_ic_cancel(m); }

/* ---------------- helpers ---------------- */
static int g_fail;
#define CHECK(c) do { if (!(c)) { fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #c); g_fail = 1; return 1; } } while (0)

static void reset_all(void)
{
    unsigned m;
    dshot_bidir_set_enabled(false);
    memset(g_sim, 0, sizeof g_sim);
    memset(g_esc, 0, sizeof g_esc);
    g_kbps = 300u;
    g_turnaround_ns = DSHOT_BIDIR_TURNAROUND_NOM_NS;
    g_edge_jitter_ns = 0u;
    g_ms_override = 0u;
    for (m = 0u; m < 4u; m++) g_sim[m].force = HAL_DSHOT_IC_OK;
    (void)dshot_set_speed_kbps(300u);
    dshot_bidir_set_enabled(true);
}

static uint32_t erpm_for(uint32_t period_us) { return dshot_gcr_period_us_to_erpm(dshot_gcr_period12_to_us(dshot_gcr_pack_period12(period_us))); }

/* One loop iteration: the mixer step runs at t, then time advances. */
static void cycle(uint32_t period_ns)
{
    static const float zero[4] = {0.f, 0.f, 0.f, 0.f};
    dshot_write(zero);
    g_now_ns += period_ns;
}

/* Decode a single simulated window directly (no pipeline). */
static bool decode_window(unsigned m, const esc_t *e, uint64_t harvest_after_tx_ns)
{
    uint16_t buf[DSHOT_TELEM_EDGE_CAP];
    sim_motor_t save = g_sim[m];
    size_t n;
    g_sim[m].buf = buf; g_sim[m].cap = DSHOT_TELEM_EDGE_CAP; g_sim[m].armed = true;
    g_sim[m].tx_ns = g_now_ns; g_sim[m].esc_at_tx = *e; g_sim[m].force = HAL_DSHOT_IC_OK;
    g_now_ns += harvest_after_tx_ns;
    harvest_motor(m);
    n = g_sim[m].n;
    {
        bool ok = dshot_telem_ingest_capture(m, buf, n, hal_dshot_ic_bit_period_ticks(m), g_sim[m].tail);
        g_sim[m] = save;
        return ok;
    }
}

/* ---------------- 1. decode from capture buffers ---------------- */
static int test_decode_buffers(void)
{
    static const uint32_t periods[] = {33u, 100u, 600u, 1000u, 2500u, 4000u, 20000u, 65408u};
    unsigned k, m, i;
    reset_all();
    g_hw_cnt = false; /* exercise in-reply timestamp wrap in the decoder */
    for (k = 0u; k < 2u; k++) {
        g_kbps = k ? 600u : 300u;
        for (m = 0u; m < 4u; m++) {
            for (i = 0u; i < sizeof periods / sizeof periods[0]; i++) {
                esc_t e = {periods[i], false, false};
                /* valid: covers terminated and unterminated final runs, and
                 * timestamps that wrap the 16-bit timer inside the frame */
                g_tick_base[m] = (uint16_t)(65535u - i * 97u);
                CHECK(decode_window(m, &e, 250000u));
                CHECK(dshot_telem_status(m) == DSHOT_TELEM_OK);
                CHECK(dshot_erpm(m) == erpm_for(periods[i]));
                CHECK(dshot_telem_period_us(m) == dshot_gcr_period12_to_us(dshot_gcr_pack_period12(periods[i])));
            }
            /* noisy: +-18% edge jitter still decodes exactly */
            g_edge_jitter_ns = dshot_bidir_reply_bit_ns(g_kbps) * 18u / 100u;
            for (i = 0u; i < 200u; i++) {
                esc_t e = {100u + (rnd() % 20000u), false, false};
                CHECK(decode_window(m, &e, 250000u));
                CHECK(dshot_telem_status(m) == DSHOT_TELEM_OK && dshot_erpm(m) == erpm_for(e.period_us));
            }
            g_edge_jitter_ns = 0u;
            /* noisy: a sub-bit spike is INVALID, never a made-up eRPM */
            {
                esc_t e = {600u, false, true};
                CHECK(!decode_window(m, &e, 250000u));
                CHECK(dshot_telem_status(m) == DSHOT_TELEM_INVALID && dshot_erpm(m) == 0u);
            }
            /* wrong CRC */
            {
                esc_t e = {600u, true, false};
                CHECK(decode_window(m, &e, 250000u));
                CHECK(dshot_telem_status(m) == DSHOT_TELEM_CRC_FAIL && dshot_erpm(m) == 0u);
            }
            /* truncated: harvest in the middle of the reply → TIMEOUT, 0 eRPM */
            {
                esc_t e = {600u, false, false};
                const uint64_t mid = dshot_bidir_frame_end_ns(g_kbps) + g_turnaround_ns +
                                     dshot_bidir_reply_ns(g_kbps) / 2u;
                CHECK(!decode_window(m, &e, mid));
                CHECK(dshot_telem_status(m) == DSHOT_TELEM_TIMEOUT && dshot_erpm(m) == 0u);
                /* 1 bit short of the end with the line still active: never padded */
                CHECK(!decode_window(m, &e, dshot_bidir_reply_end_ns(g_kbps, g_turnaround_ns) -
                                            dshot_bidir_reply_bit_ns(g_kbps) / 2u));
                CHECK(dshot_telem_status(m) == DSHOT_TELEM_TIMEOUT);
            }
            /* silent ESC: TIMEOUT */
            {
                esc_t e = {0u, false, false};
                CHECK(!decode_window(m, &e, 250000u));
                CHECK(dshot_telem_status(m) == DSHOT_TELEM_TIMEOUT && dshot_erpm(m) == 0u);
            }
        }
    }
    /* Pre-frame glitch edge 20 us before the reply is skipped (long idle run). */
    {
        uint16_t ts[40];
        uint64_t t[40];
        esc_t e = {600u, false, false};
        size_t n, i2;
        g_kbps = 300u;
        n = esc_edges(&e, t, 40u);
        ts[0] = to_ticks(0u, t[0] - 20000u);
        for (i2 = 0u; i2 < n; i2++) ts[i2 + 1u] = to_ticks(0u, t[i2]);
        CHECK(dshot_telem_ingest_capture(0u, ts, n + 1u, hal_dshot_ic_bit_period_ticks(0u), HAL_DSHOT_IC_TAIL_QUIET));
        CHECK(dshot_telem_status(0u) == DSHOT_TELEM_OK && dshot_erpm(0u) == erpm_for(600u));
    }
    g_hw_cnt = true;
    return 0;
}

/* ---------------- 2. state machine across loop iterations ---------------- */
static int run_pipeline(uint32_t loop_hz, unsigned kbps, unsigned iters, int jitter_us)
{
    unsigned it, m;
    const uint32_t period_ns = 1000000000u / loop_hz;
    reset_all();
    g_kbps = kbps;
    CHECK(dshot_set_speed_kbps(kbps));
    g_now_ns = 5000000000ull;
    for (it = 0u; it < iters; it++) {
        uint32_t p;
        /* A different eRPM per motor per iteration: proves one-cycle lag and
         * motor independence. */
        for (m = 0u; m < 4u; m++) g_esc[m].period_us = 300u + 50u * m + 7u * it;
        {
            int32_t j = jitter_us ? (int32_t)(rnd() % (2u * (unsigned)jitter_us + 1u)) - jitter_us : 0;
            p = (uint32_t)((int32_t)period_ns + j * 1000);
        }
        cycle(p);
        if (it == 0u) {
            for (m = 0u; m < 4u; m++) CHECK(dshot_telem_status(m) == DSHOT_TELEM_NONE);
            continue;
        }
        /* dshot_write of iteration `it` harvested the reply to frame it-1. */
        for (m = 0u; m < 4u; m++) {
            if (dshot_telem_status(m) != DSHOT_TELEM_OK)
                fprintf(stderr, "pipeline %u Hz DShot%u it=%u m=%u status=%d n=%zu tail=%u res=%d\n", loop_hz, kbps, it, m,
                        (int)dshot_telem_status(m), g_sim[m].n, g_sim[m].tail, (int)g_sim[m].result);
            CHECK(dshot_telem_status(m) == DSHOT_TELEM_OK);
            CHECK(dshot_erpm(m) == erpm_for(300u + 50u * m + 7u * (it - 1u)));
        }
    }
    CHECK(!dshot_telem_capture_failed() && dshot_telem_capture_fail_streak() == 0u);
    CHECK(dshot_telem_cycles() == iters - 1u);
    return 0;
}

static int test_state_machine(void)
{
    /* 4 kHz (250 us) and the 1 kHz fallback, DShot300/600, +-20 us cascade jitter. */
    if (run_pipeline(4000u, 300u, 400u, 20)) return 1;
    if (run_pipeline(4000u, 600u, 400u, 20)) return 1;
    if (run_pipeline(1000u, 300u, 200u, 20)) return 1;
    if (run_pipeline(1000u, 600u, 200u, 20)) return 1;
    if (run_pipeline(2000u, 300u, 200u, 20)) return 1;   /* guard step 4000/2 */
    /* Worst budgeted turnaround (40 us) still fits 4 kHz at DShot300. */
    g_turnaround_ns = DSHOT_BIDIR_TURNAROUND_MAX_NS;
    {
        unsigned it, m;
        reset_all();
        g_turnaround_ns = DSHOT_BIDIR_TURNAROUND_MAX_NS;
        for (m = 0u; m < 4u; m++) g_esc[m].period_us = 777u;
        for (it = 0u; it < 100u; it++) cycle(250000u - 30000u); /* and 30 us early harvest */
        for (m = 0u; m < 4u; m++) CHECK(dshot_telem_status(m) == DSHOT_TELEM_OK && dshot_erpm(m) == erpm_for(777u));
        CHECK(!dshot_telem_capture_failed());
    }
    /* Independent failure: M2's ESC silent, M3 corrupt, M1/M4 fine. */
    {
        unsigned it;
        reset_all();
        g_esc[0].period_us = 500u; g_esc[1].period_us = 0u;
        g_esc[2].period_us = 500u; g_esc[2].corrupt_crc = true; g_esc[3].period_us = 900u;
        for (it = 0u; it < 50u; it++) cycle(250000u);
        CHECK(dshot_telem_status(0u) == DSHOT_TELEM_OK && dshot_erpm(0u) == erpm_for(500u));
        CHECK(dshot_telem_status(1u) == DSHOT_TELEM_TIMEOUT && dshot_erpm(1u) == 0u);
        CHECK(dshot_telem_status(2u) == DSHOT_TELEM_CRC_FAIL && dshot_erpm(2u) == 0u);
        CHECK(dshot_telem_status(3u) == DSHOT_TELEM_OK && dshot_erpm(3u) == erpm_for(900u));
        CHECK(!dshot_telem_capture_failed()); /* silence / CRC are not capture failures */
    }
    /* Age / STALE across iterations: ESC goes silent, age grows, STALE at 100 ms. */
    {
        unsigned it;
        reset_all();
        g_now_ns = 9000000000ull;
        g_esc[0].period_us = 700u;
        for (it = 0u; it < 10u; it++) cycle(250000u);
        CHECK(dshot_telem_status(0u) == DSHOT_TELEM_OK && dshot_telem_age_ms(0u) == 0u);
        g_esc[0].period_us = 0u;
        for (it = 0u; it < 400u; it++) cycle(250000u); /* 100 ms of silence */
        CHECK(dshot_telem_status(0u) != DSHOT_TELEM_OK && dshot_erpm(0u) == 0u);
        CHECK(dshot_telem_age_ms(0u) >= 99u);
        for (it = 0u; it < 8u; it++) cycle(250000u);
        CHECK(dshot_telem_status(0u) == DSHOT_TELEM_STALE);
    }
    return 0;
}

/* ---------------- 3. no-block guarantee ---------------- */
static double mono_us(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1e6 + (double)ts.tv_nsec / 1e3;
}

static int test_no_block(void)
{
    unsigned it;
    double worst = 0.0;
    reset_all();
    g_collect_calls = g_take_calls = 0u;
    /* ESCs never answer (USB-only bench): every step returns at once. */
    for (it = 0u; it < 20000u; it++) {
        double t0 = mono_us();
        cycle(250000u);
        {
            double dt = mono_us() - t0;
            if (it > 10u && dt > worst) worst = dt;
        }
    }
    /* Structural: exactly one harvest per cycle and one take per motor — a
     * polling/spinning receive path would call the HAL repeatedly. */
    CHECK(g_collect_calls == 20000u - 1u);
    CHECK(g_take_calls == 4u * (20000u - 1u));
    /* Wall clock (host, generous bound): far below the old >=156 us listen. */
    CHECK(worst < 2000.0);
    printf("no-block: 20000 silent cycles, worst dshot_write %.1f us (host), %u harvests\n", worst, g_collect_calls);
    for (it = 0u; it < 4u; it++) CHECK(dshot_telem_status(it) == DSHOT_TELEM_TIMEOUT && dshot_erpm(it) == 0u);
    CHECK(!dshot_telem_capture_failed()); /* silence never forces 1 kHz */
    return 0;
}

/* ---------------- 4. capture-failure fallback latch ---------------- */
static int test_fallback_latch(void)
{
    unsigned it;
    reset_all();
    for (it = 0u; it < 4u; it++) g_esc[it].period_us = 600u;
    cycle(250000u); /* prime */
    g_sim[2].force = HAL_DSHOT_IC_TX_NOT_DONE;
    for (it = 0u; it < DSHOT_TELEM_CAPTURE_FAIL_LIMIT - 1u; it++) cycle(250000u);
    CHECK(!dshot_telem_capture_failed() && dshot_telem_capture_fail_streak() == DSHOT_TELEM_CAPTURE_FAIL_LIMIT - 1u);
    CHECK(dshot_telem_status(2u) == DSHOT_TELEM_TIMEOUT && dshot_erpm(2u) == 0u);
    CHECK(dshot_telem_status(0u) == DSHOT_TELEM_OK);
    /* One clean cycle resets the streak. */
    g_sim[2].force = HAL_DSHOT_IC_OK;
    cycle(250000u); cycle(250000u);
    CHECK(dshot_telem_capture_fail_streak() == 0u);
    /* DMA errors latch after the limit. */
    g_sim[1].force = HAL_DSHOT_IC_DMA_ERROR;
    for (it = 0u; it < DSHOT_TELEM_CAPTURE_FAIL_LIMIT; it++) cycle(250000u);
    CHECK(dshot_telem_capture_failed());
    /* Latched even after the fault clears (never raises by itself)... */
    g_sim[1].force = HAL_DSHOT_IC_OK;
    for (it = 0u; it < 100u; it++) cycle(250000u);
    CHECK(dshot_telem_capture_failed());
    /* ...and at 1 kHz the same (healthy) capture keeps decoding. */
    for (it = 0u; it < 20u; it++) cycle(1000000u);
    for (it = 0u; it < 4u; it++) CHECK(dshot_telem_status(it) == DSHOT_TELEM_OK && dshot_erpm(it) == erpm_for(600u));
    /* bidir off/on clears the latch. */
    dshot_bidir_set_enabled(false);
    CHECK(!dshot_telem_capture_failed() && dshot_telem_status(0u) == DSHOT_TELEM_NONE && !g_inverted);
    dshot_bidir_set_enabled(true);
    CHECK(!dshot_telem_capture_failed() && g_inverted);
    /* Truncation every cycle (8 kHz slot at DShot300: 125 us < 142 us reply end)
     * is a capture failure and latches too. */
    reset_all();
    for (it = 0u; it < 4u; it++) g_esc[it].period_us = 600u;
    for (it = 0u; it < DSHOT_TELEM_CAPTURE_FAIL_LIMIT + 1u; it++) cycle(125000u);
    CHECK(dshot_telem_capture_failed());
    for (it = 0u; it < 4u; it++) CHECK(dshot_telem_status(it) == DSHOT_TELEM_TIMEOUT && dshot_erpm(it) == 0u);
    return 0;
}

/* ---------------- 5. loop-rate interplay (#57 policy on live state) ---------------- */
static loop_rate_t policy(uint32_t requested, const char **why)
{
    loop_rate_inputs_t in;
    memset(&in, 0, sizeof in);
    in.requested_hz = requested;
    in.board_fast = true;
    in.high_res_time = true;
    in.dshot_bidir = dshot_bidir_enabled();
    in.dshot_kbps = dshot_speed_kbps();
    in.dshot_capture_failed = dshot_telem_capture_failed();
    in.gyro_healthy = true;
    in.gyro_odr_hz = 8000u;
    in.gyro_spi_hz = 13500000u;
    return loop_rate_select(&in, why);
}

static int test_loop_rate_interplay(void)
{
    const char *why = NULL;
    loop_rate_t r;
    unsigned it;
    /* Budget verdicts used by the policy. */
    CHECK(dshot_bidir_window_fits(4000u, 300u) && dshot_bidir_window_fits(4000u, 600u));
    CHECK(dshot_bidir_window_fits(1000u, 300u) && dshot_bidir_window_fits(2000u, 300u));
    CHECK(!dshot_bidir_window_fits(8000u, 300u) && !dshot_bidir_window_fits(8000u, 600u));
    CHECK(dshot_bidir_need_ns(300u) <= 250000u - 60000u); /* >= 60 us worst-case margin at 4 kHz */

    reset_all();
    r = policy(4000u, &why);
    CHECK(r.gyro_hz == 8000u && r.pid_denom == 2u && !strcmp(why, "setting"));
    r = policy(8000u, &why);
    CHECK(r.gyro_hz == 8000u && r.pid_denom == 2u && !strcmp(why, "dshot-bidir-reply-window"));
    (void)dshot_set_speed_kbps(600u);
    r = policy(8000u, &why);
    CHECK(r.gyro_hz == 8000u && r.pid_denom == 2u && !strcmp(why, "dshot-bidir-reply-window"));
    (void)dshot_set_speed_kbps(300u);
    /* Healthy 4 kHz pipeline keeps 4000. */
    for (it = 0u; it < 4u; it++) g_esc[it].period_us = 600u;
    for (it = 0u; it < 200u; it++) cycle(250000u);
    r = policy(4000u, &why);
    CHECK(r.gyro_hz == 8000u && r.pid_denom == 2u && !strcmp(why, "setting"));
    /* Repeated capture failure → 1000/1 with the reason. */
    g_sim[0].force = HAL_DSHOT_IC_TX_NOT_DONE;
    for (it = 0u; it < DSHOT_TELEM_CAPTURE_FAIL_LIMIT; it++) cycle(250000u);
    r = policy(4000u, &why);
    CHECK(r.gyro_hz == 1000u && r.pid_denom == 1u && !strcmp(why, "dshot-bidir-capture-failed"));
    r = policy(8000u, &why);
    CHECK(r.gyro_hz == 1000u && !strcmp(why, "dshot-bidir-capture-failed"));
    /* bidir off: full #57 behaviour back (8000/1 allowed again). */
    dshot_bidir_set_enabled(false);
    r = policy(8000u, &why);
    CHECK(r.gyro_hz == 8000u && r.pid_denom == 1u && !strcmp(why, "setting"));
    return 0;
}

/* Tail across a 16-bit timer wrap (TIM1 @216 MHz wraps every ~302 us, i.e.
 * inside one 1 kHz period): never alias a long quiet time into a short one,
 * always a lower bound. */
static int test_tail_wrap(void)
{
    /* No wrap: exact. */
    CHECK(dshot_ic_tail_ticks(100u, 5000u, 6000u, false, false) == 1000u);
    CHECK(dshot_ic_tail_ticks(65000u, 200u, 300u, false, false) == 100u); /* wrapped low half, no UIF */
    CHECK(dshot_ic_tail_ticks(100u, 5000u, 6000u, false, true) == 0u);    /* edge pending */
    /* The 1 kHz alias seen in the pipeline sim: last edge at open+30000,
     * harvest 65536+609 ticks after it. A plain difference says 609. */
    CHECK((uint16_t)(30609u - 30000u) == 609u);
    CHECK(dshot_ic_tail_ticks(0u, 30000u, 30609u, true, false) == 0xFFFFu);
    /* Wrapped, last edge before the wrap: (0x10000 - last) + now. */
    CHECK(dshot_ic_tail_ticks(300u, 65000u, 100u, true, false) == 636u);
    CHECK(dshot_ic_tail_ticks(300u, 40000u, 200u, true, false) == 25736u);
    /* Wrapped, last edge after the wrap (below cnt_open): 16-bit difference. */
    CHECK(dshot_ic_tail_ticks(300u, 10u, 250u, true, false) == 240u);
    CHECK(dshot_ic_tail_ticks(300u, 65000u, 100u, true, true) == 0u);
    return 0;
}

int main(void)
{
    if (test_tail_wrap()) return 1;
    if (test_decode_buffers()) return 1;
    if (test_state_machine()) return 1;
    if (test_no_block()) return 1;
    if (test_fallback_latch()) return 1;
    if (test_loop_rate_interplay()) return 1;
    printf("PASS: B2 bidir eRPM 4 kHz: GCR from capture buffers (valid/noisy/truncated/CRC/wrap/unterminated), "
           "pipelined state machine at 4 kHz + 1 kHz (DShot300/600, jitter), no-block, capture-failure latch -> 1000/1, "
           "loop-rate interplay (4000 kept, 8000 capped to 8000/2)\n");
    return g_fail;
}
