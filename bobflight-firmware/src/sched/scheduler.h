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
} scheduler_stats_t;

void scheduler_init(uint32_t gyro_hz, uint32_t pid_process_denom);
void scheduler_run(void); /* one cooperative slice; call in for(;;) */

const scheduler_stats_t *scheduler_stats(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_SCHEDULER_H */
