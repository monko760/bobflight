/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Clean-room QUADX mixer. Motor index matches DShot channel 0..3:
 *   0 rear-right, 1 front-right, 2 rear-left, 3 front-left.
 * When armed, stick throttle is floored by min_throttle and motors get a
 * post-mix idle floor so they do not sit at 0 (AirMode idle). ARMING_THROTTLE_MAX
 * remains a separate arm gate. Disarmed callers still force motors to 0 in tasks.
 */
#include "flight/mixer.h"
#include "flight/config.h"
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
    const bf_config_t *cfg;
    float mt;
    float thr;

    if (!motor_out) {
        return;
    }

    if(!isfinite(throttle) || (pid && (!isfinite(pid->roll)||!isfinite(pid->pitch)||!isfinite(pid->yaw)))){for(unsigned i=0;i<4;i++)motor_out[i]=0;return;}

    cfg = config_get();
    mt = cfg ? clampf(cfg->min_throttle, 0.f, 0.2f) : 0.f;
    thr = clampf(throttle, 0.f, 1.f);
    if (thr < mt) {
        thr = mt;
    }

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
        if (mt > 0.f && motor_out[i] < mt) {
            motor_out[i] = mt;
        }
    }
}
