/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Realtime cascade + background task declarations.
 */
#ifndef BOBFLIGHT_TASKS_H
#define BOBFLIGHT_TASKS_H
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {

#endif

/* Cascade (cooperative; never block): gyro → filter → pid → mixer → dshot */
/* Experimental RAM-only setpoint routing; never changes arming permission. */
typedef enum {
    CONTROL_MODE_ANGLE = 0,
    CONTROL_MODE_ACRO = 1,
    CONTROL_MODE_HORIZON = 2
} control_mode_t;
control_mode_t control_mode_get(void);
const char *control_mode_name(void);
bool control_mode_set(control_mode_t mode);
bool control_source_set(bool use_aux);
const char *control_source_name(void);
control_mode_t control_mode_requested(void);
const char *control_requested_name(void);
const char *control_effective_name(void);
bool control_mode_conflict(void);

void loop_gyro(void);
void loop_filter(void);
void loop_pid(void);
void loop_mixer_dshot(void);

/* Background (polled when cascade idle) */
void bg_rx_poll(void);
void bg_cli_poll(void);
void bg_failsafe_tick(void);
#define BENCH_PULSE_MAX_PERCENT 35u
/** One-second adjustable pulse; valid motor 1..4, integer percent 0..35.
 * Zero stops all bench output. Does not arm flight. */
bool bench_motor_pulse(unsigned motor, unsigned percent);
bool bench_motor_test(unsigned motor);
/** Test queued/running, or nonzero output not yet replaced by a stop frame. */
bool bench_motor_active(void);
/** Props-off AUX1 session: fixed 8%, 3s/run, 60s/session; never flight-arms. */
bool bench_switch_start(void);
void bench_switch_stop(void);
const char *bench_switch_status(void);
/** Spin motors 1..4 in order (RR, FR, RL, FL), 1s each, props-off bench use. */
bool bench_motor_seq_start(void);

#ifdef __cplusplus
}

#endif


#endif /* BOBFLIGHT_TASKS_H */

