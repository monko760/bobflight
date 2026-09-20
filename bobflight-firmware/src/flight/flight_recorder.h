/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Core flight recorder FIFO and session decimation.
 */
#ifndef BOBFLIGHT_FLIGHT_RECORDER_H
#define BOBFLIGHT_FLIGHT_RECORDER_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FLIGHT_RECORDER_QUEUE_CAPACITY 64

typedef struct {
    uint32_t iteration;
    uint32_t time_us;       /* Session-relative timestamp */
    uint32_t dt_us;
    float gyro_raw[3];
    float gyro[3];
    float setpoint[3];
    float p[3];
    float i[3];
    float d[3];
    float pid_output[3];
    float motor[4];         /* [0.0, 1.0] normalized command */
    float rc[4];            /* R/P/Y [-1.0, 1.0], Throttle [0.0, 1.0] */
    uint8_t armed;
    uint8_t mode;
    uint8_t failsafe;
    uint32_t dropped;       /* Cumulative drops prior to this record */
} flight_log_sample_t;

typedef struct {
    uint32_t rate_hz;
    uint32_t total_attempted;
    uint32_t total_accepted;
    uint32_t total_dropped;
    uint32_t total_skipped; /* Deliberately decimated calls */
    uint32_t total_missed; /* Elapsed logging slots not fabricated */
    uint32_t total_invalid;
    uint32_t total_regressed;
    uint32_t queue_depth;
    uint32_t queue_capacity;
} flight_recorder_stats_t;

void recorder_reset(void);
bool recorder_start(uint32_t rate_hz);
void recorder_stop(void);
bool recorder_capture(const flight_log_sample_t *sample);
bool recorder_pop(flight_log_sample_t *out_sample);
bool recorder_active(void);
const flight_recorder_stats_t *recorder_stats(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_FLIGHT_RECORDER_H */
