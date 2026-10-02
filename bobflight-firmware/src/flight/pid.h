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
/* Safety S1 anti-windup: the mixer reports after every armed cascade whether
 * it had to scale the PID part down to fit the motors in [min_throttle, 1].
 * While set, each axis' I accumulator is frozen (it may still shrink toward
 * zero). Cleared by pid_init(). */
void pid_set_mixer_saturated(bool saturated);
/* Safety S1: second-order D-term LPF (two first-order stages, still -3 dB at
 * dterm_lpf_hz). Set once at boot: on when the gyro runs wide-band (8 kHz
 * ODR / DLPF 0, Kakute at loop_rate_hz 4000 or 8000), off otherwise. */
void pid_set_dterm_lpf_pt2(bool enabled);
bool pid_dterm_lpf_pt2(void);
void pid_set_dt(float dt);
void pid_update(const float gyro_dps[3], const float setpoint_dps[3],
                pid_axis_out_t *out);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_PID_H */
