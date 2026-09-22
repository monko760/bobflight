/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rate PID (roll/pitch/yaw) — static gains in pid.c.
 */
#ifndef BOBFLIGHT_PID_H
#define BOBFLIGHT_PID_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    float roll;
    float pitch;
    float yaw;
} pid_axis_out_t;

/* Production-loop trace, not the isolated disarmed diagnostic. */
typedef struct {
    bool valid;
    float dt;
    float gyro[3], setpoint[3], error[3];
    float p[3], i[3], d[3], sum[3], output[3];
} pid_trace_t;
/* Disabled by default; foreground-only. Reset invalidates the snapshot. */
void pid_trace_enable(bool enabled);
bool pid_trace_read(pid_trace_t *out);

void pid_init(void);
void pid_set_dt(float dt);
void pid_update(const float gyro_dps[3], const float setpoint_dps[3],
                pid_axis_out_t *out);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_PID_H */
