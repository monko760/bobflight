/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cooperative scheduler: gyro deadline cascade + background queue.
 * No FreeRTOS for MVP.
 */
#ifndef BOBFLIGHT_SCHEDULER_H
#define BOBFLIGHT_SCHEDULER_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t gyro_hz;           /* e.g. 8000 dummy */
    uint32_t pid_process_denom; /* e.g. 2 → 4 kHz PID if 8 kHz gyro */
    uint32_t cascade_runs;
    uint32_t bg_runs;
    uint32_t gyro_period_us;
    uint64_t started_us, gyro_runs, pid_runs, skipped_deadlines, overruns;
    uint32_t gyro_interval_last_us,gyro_interval_min_us,gyro_interval_max_us;
    uint32_t pid_interval_last_us,pid_interval_min_us,pid_interval_max_us;
    uint32_t gyro_jitter_max_us,pid_jitter_max_us,start_lateness_max_us;
    uint32_t gyro_exec_max_us,cascade_exec_max_us;
    bool gyro_interval_valid,pid_interval_valid;
    /* Rolling loop-rate window (frozen `status` loop_actual_hz contract).
     * Windows are consecutive ~1 s spans of scheduler time, restarted on a
     * rate change. overruns / skipped_deadlines above stay since-boot. */
    uint64_t loop_window_start_us;
    uint32_t loop_window_open_runs, loop_window_open_gyro, loop_window_open_overruns;
    uint32_t loop_actual_hz;      /* PID cascade runs/s of the last closed window */
    uint32_t loop_window_gyro_runs, loop_window_overruns; /* last closed window */
    uint32_t loop_window_seq;     /* windows closed since init / last rate change */
    uint32_t rate_changes;        /* scheduler_set_rate() calls that changed rate */
    bool loop_actual_valid;
} scheduler_stats_t;

/* Fallbacks used by scheduler_init for invalid arguments; also the nominal
 * rate tasks assume before any scheduler_init (host unit tests only). */
#define SCHEDULER_DEFAULT_GYRO_HZ 8000u
#define SCHEDULER_DEFAULT_PID_DENOM 2u
/* loop_actual_hz window length. */
#define SCHEDULER_LOOP_WINDOW_US 1000000u

void scheduler_init(uint32_t gyro_hz, uint32_t pid_process_denom);
void scheduler_run(void); /* one cooperative slice; call in for(;;) */

const scheduler_stats_t *scheduler_stats(void);

/* Change gyro task rate / PID divider at runtime (loop-rate policy fallback).
 * Keeps since-boot counters (overruns, skipped slots, cascade/bg runs, exec
 * maxima); restarts rate averages, interval/jitter stats and the loop window. */
void scheduler_set_rate(uint32_t gyro_hz, uint32_t pid_process_denom);
/* gyro_hz / pid_process_denom (0 before scheduler_init). */
uint32_t scheduler_loop_target_hz(void);
/* PID cascade runs over the last closed ~1 s window. False (unavailable)
 * until the first window closes. A window left open for 2+ windows means the
 * cascade stalled; the open window is then reported so the drop is visible. */
bool scheduler_loop_actual_hz(uint64_t now, uint32_t *hz);

/* Background time budget: microseconds a cooperative background task may use
 * starting at `now` without delaying the next gyro deadline. Leaves
 * SCHEDULER_BG_GUARD_US before the deadline and caps at SCHEDULER_BG_MAX_US.
 * Before scheduler_init it returns SCHEDULER_BG_UNSCHEDULED_US. */
#define SCHEDULER_BG_GUARD_US 20u
#define SCHEDULER_BG_MAX_US 200u
#define SCHEDULER_BG_UNSCHEDULED_US 50u
uint32_t scheduler_bg_budget_us(uint64_t now);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_SCHEDULER_H */
