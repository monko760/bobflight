/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Clean-room QUADX mixer. Motor index matches DShot channel 0..3:
 *   0 rear-right, 1 front-right, 2 rear-left, 3 front-left.
 */
#include "flight/mixer.h"
#include <math.h>


static float clampf(float v, float lo, float hi)
{
    if (v < lo) {
        return lo;
    }
    if (v > hi) {
        return hi;
    }
    return v;
}

void mixer_init(void) {}

void mixer_update(const pid_axis_out_t *pid, float throttle, float motor_out[MIXER_MOTOR_COUNT])
{
    if (!motor_out) {
        return;
    }

    if(!isfinite(throttle) || (pid && (!isfinite(pid->roll)||!isfinite(pid->pitch)||!isfinite(pid->yaw)))){for(unsigned i=0;i<4;i++)motor_out[i]=0;return;}
    const float thr = clampf(throttle, 0.f, 1.f);
    const float roll = pid ? pid->roll : 0.f;
    const float pitch = pid ? pid->pitch : 0.f;
    const float yaw = pid ? pid->yaw : 0.f;

    /* QUADX: +roll banks right, +pitch raises nose, +yaw CW looking down. */
    motor_out[0] = thr - roll + pitch - yaw; /* rear-right */
    motor_out[1] = thr - roll - pitch + yaw; /* front-right */
    motor_out[2] = thr + roll + pitch + yaw; /* rear-left */
    motor_out[3] = thr + roll - pitch - yaw; /* front-left */

    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        motor_out[i] = clampf(motor_out[i], 0.f, 1.f);
    }
}
