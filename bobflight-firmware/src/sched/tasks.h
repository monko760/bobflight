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
void loop_gyro(void);
void loop_filter(void);
void loop_pid(void);
void loop_mixer_dshot(void);

/* Background (polled when cascade idle) */
void bg_rx_poll(void);
void bg_cli_poll(void);
void bg_failsafe_tick(void);
bool bench_motor_test(unsigned motor);

#ifdef __cplusplus
}

#endif


#endif /* BOBFLIGHT_TASKS_H */

