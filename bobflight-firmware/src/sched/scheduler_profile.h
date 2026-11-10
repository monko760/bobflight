/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_SCHEDULER_PROFILE_H
#define BOBFLIGHT_SCHEDULER_PROFILE_H
#include <stdbool.h>
#include <stdint.h>
#define SCHEDULER_PROFILE_WINDOW_US 3000000u
typedef enum {
 PROFILE_GYRO, PROFILE_FILTER, PROFILE_PID, PROFILE_MOTOR_OUTPUT,
 PROFILE_RX, PROFILE_FAILSAFE, PROFILE_CLI, PROFILE_OUTSIDE_GAP,
 PROFILE_STAGE_COUNT
} scheduler_profile_stage_t;
typedef enum {
 PROFILE_OFF, PROFILE_RUNNING, PROFILE_COMPLETE, PROFILE_STOPPED,
 PROFILE_ARMED, PROFILE_MOTOR_ACTIVE, PROFILE_CLOCK_INVALID, PROFILE_RATE_CHANGED
} scheduler_profile_state_t;
typedef struct { uint64_t total_us; uint32_t runs,max_us; } scheduler_profile_cost_t;
typedef struct {
 scheduler_profile_state_t state;
 uint32_t gyro_hz,pid_denom;
 uint64_t started_us,elapsed_us;
 scheduler_profile_cost_t stages[PROFILE_STAGE_COUNT];
} scheduler_profile_stats_t;
/* Foreground-owned. Start requires initialized scheduler, disarmed motors,
 * inactive motor bench and a working high-resolution clock. Normal OFF
 * scheduling adds no timestamp reads; captures expire after ~3 seconds. */
bool scheduler_profile_start(void);
void scheduler_profile_stop(void);
const scheduler_profile_stats_t *scheduler_profile_stats(void);
const char *scheduler_profile_state_name(scheduler_profile_state_t state);
#endif
