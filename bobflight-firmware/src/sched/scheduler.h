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
} scheduler_stats_t;

void scheduler_init(uint32_t gyro_hz, uint32_t pid_process_denom);
void scheduler_run(void); /* one cooperative slice; call in for(;;) */

const scheduler_stats_t *scheduler_stats(void);

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
