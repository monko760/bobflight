/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rate PID (roll/pitch/yaw) — static gains in pid.c.
 */
#ifndef BOBFLIGHT_PID_H
#define BOBFLIGHT_PID_H

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    float roll;
    float pitch;
    float yaw;
} pid_axis_out_t;

void pid_init(void);
void pid_set_dt(float dt);
void pid_update(const float gyro_dps[3], const float setpoint_dps[3],
                pid_axis_out_t *out);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_PID_H */
