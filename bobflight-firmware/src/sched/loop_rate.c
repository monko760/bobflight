/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "sched/loop_rate.h"
#include "sched/loop_rate_setting.h"
#include "sched/scheduler.h"
#include "drivers/gyro.h"
#include "drivers/dshot_telem.h"
#include "flight/arming.h"
#include "hal/hal.h"

static const loop_rate_t k_8k = {LOOP_RATE_FAST_GYRO_HZ, LOOP_RATE_8K_PID_DENOM};
static const loop_rate_t k_fast = {LOOP_RATE_FAST_GYRO_HZ, LOOP_RATE_FAST_PID_DENOM};
static const loop_rate_t k_reduced = {LOOP_RATE_REDUCED_GYRO_HZ, LOOP_RATE_REDUCED_PID_DENOM};
static const loop_rate_t k_legacy = {LOOP_RATE_LEGACY_GYRO_HZ, LOOP_RATE_LEGACY_PID_DENOM};

static bool g_board_fast;
static uint32_t g_boot_setting_hz = LOOP_RATE_SETTING_1K;
static unsigned g_guard_level, g_breaches;
static uint32_t g_seen_seq, g_seen_changes;
static const char *g_reason = "not-initialized";

unsigned loop_rate_ladder(uint32_t requested_hz, loop_rate_t out[LOOP_RATE_LADDER_MAX])
{
    unsigned n = 0;
    if (requested_hz == LOOP_RATE_SETTING_8K) out[n++] = k_8k;
    if (requested_hz == LOOP_RATE_SETTING_8K || requested_hz == LOOP_RATE_SETTING_4K) {
        out[n++] = k_fast;
        out[n++] = k_reduced;
    }
    out[n++] = k_legacy;
    return n;
}

loop_rate_t loop_rate_select(const loop_rate_inputs_t *in, const char **reason)
{
    const char *r = "setting";
    loop_rate_t out = k_legacy;
    loop_rate_t ladder[LOOP_RATE_LADDER_MAX];
    const unsigned n = loop_rate_ladder(in ? in->requested_hz : LOOP_RATE_SETTING_1K, ladder);
    if (!in || n == 1u) {
        /* Setting 1000 (or anything unrecognised): the pre-R3 1000 / 1 path. */
    } else if (!in->board_fast) {
        r = "board-has-no-8k-gyro-path";
    } else if (!in->high_res_time) {
        r = "no-high-res-timebase";
    } else if (in->dshot_bidir) {
        /* Polled bidir listen blocks >= ~95-156 us plus a 0.5-1.1 ms quiet gap
         * per cascade (docs/LOOP-RATE.md); cannot fit a 125 us gyro slot. */
        r = "dshot-bidir-polled-listen";
    } else if (in->gyro_healthy && in->gyro_odr_hz < LOOP_RATE_FAST_GYRO_HZ) {
        r = "gyro-odr-below-8k";
    } else if (in->gyro_healthy && in->gyro_spi_hz < LOOP_RATE_MIN_GYRO_SPI_HZ) {
        r = "gyro-spi-clock-slow";
    } else {
        const unsigned level = in->guard_level < n ? in->guard_level : n - 1u;
        out = ladder[level];
        if (level) r = "overrun-guard";
    }
    if (reason) *reason = r;
    return out;
}

bool loop_rate_window_breach(uint32_t overruns, uint32_t gyro_slots)
{
    if (!gyro_slots) return overruns != 0u;
    return (uint64_t)overruns * 1000u > (uint64_t)gyro_slots * LOOP_RATE_GUARD_PERMILLE;
}

static loop_rate_inputs_t gather(void)
{
    const gyro_diagnostics_t *g = gyro_diagnostics();
    loop_rate_inputs_t in = {0};
    in.requested_hz = g_boot_setting_hz;
    in.board_fast = g_board_fast;
    in.high_res_time = hal_time_high_resolution();
    in.dshot_bidir = dshot_bidir_enabled();
    in.gyro_healthy = gyro_is_healthy();
    /* A failed or unknown sensor configuration counts as below 8 kHz. */
    in.gyro_odr_hz = g && g->config_ok ? g->odr_hz : 0u;
    in.gyro_spi_hz = g && g->config_ok ? g->spi_read_hz : 0u;
    in.guard_level = g_guard_level;
    return in;
}

static uint32_t loop_hz(loop_rate_t r) { return r.pid_denom ? r.gyro_hz / r.pid_denom : 0u; }

void loop_rate_init(void)
{
    g_board_fast = loop_rate_board_fast(board_get());
    g_boot_setting_hz = loop_rate_setting_get();
    g_guard_level = g_breaches = 0u;
    loop_rate_inputs_t in = gather();
    loop_rate_t r = loop_rate_select(&in, &g_reason);
    scheduler_init(r.gyro_hz, r.pid_denom);
    g_seen_seq = 0u;
    g_seen_changes = scheduler_stats()->rate_changes;
}

void loop_rate_tick(void)
{
    const scheduler_stats_t *s = scheduler_stats();
    if (!s || !s->gyro_period_us) return;
    if (s->rate_changes != g_seen_changes) {
        g_seen_changes = s->rate_changes;
        g_seen_seq = 0u;
        g_breaches = 0u;
    }
    if (s->loop_window_seq != g_seen_seq) {
        g_seen_seq = s->loop_window_seq;
        /* Budget guard only judges the requested ladder, never a rate that a
         * known blocking mode (bidir, no timebase) already forced down. */
        loop_rate_t ladder[LOOP_RATE_LADDER_MAX];
        const unsigned n = loop_rate_ladder(g_boot_setting_hz, ladder);
        const bool guarded = g_board_fast && n > 1u &&
            (strcmp(g_reason, "setting") == 0 || strcmp(g_reason, "overrun-guard") == 0);
        if (guarded && g_guard_level + 1u < n) {
            if (loop_rate_window_breach(s->loop_window_overruns, s->loop_window_gyro_runs)) {
                if (++g_breaches >= LOOP_RATE_GUARD_BREACHES) {
                    g_guard_level++;
                    g_breaches = 0u;
                }
            } else {
                g_breaches = 0u;
            }
        }
    }
    loop_rate_inputs_t in = gather();
    const char *reason;
    loop_rate_t want = loop_rate_select(&in, &reason);
    if (want.gyro_hz == s->gyro_hz && want.pid_denom == s->pid_process_denom) {
        g_reason = reason;
        return;
    }
    /* Lowering is always allowed; raising waits until disarmed. */
    const bool lower = loop_hz(want) < scheduler_loop_target_hz() ||
                       (loop_hz(want) == scheduler_loop_target_hz() && want.gyro_hz < s->gyro_hz);
    if (!lower && arming_state() == ARM_ARMED) return;
    scheduler_set_rate(want.gyro_hz, want.pid_denom);
    g_reason = reason;
}

loop_rate_t loop_rate_requested_profile(void)
{
    loop_rate_t ladder[LOOP_RATE_LADDER_MAX];
    (void)loop_rate_ladder(g_boot_setting_hz, ladder);
    return ladder[0];
}
uint32_t loop_rate_boot_setting_hz(void) { return g_boot_setting_hz; }
bool loop_rate_pending_reboot(void) { return loop_rate_setting_get() != g_boot_setting_hz; }
loop_rate_t loop_rate_active(void)
{
    const scheduler_stats_t *s = scheduler_stats();
    loop_rate_t r = {s ? s->gyro_hz : 0u, s ? s->pid_process_denom : 0u};
    return r;
}
const char *loop_rate_reason(void) { return g_reason; }
unsigned loop_rate_guard_level(void) { return g_guard_level; }
