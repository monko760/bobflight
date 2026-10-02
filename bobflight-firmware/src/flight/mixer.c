/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Clean-room QUADX mixer. Motor index matches DShot channel 0..3:
 *   0 rear-right, 1 front-right, 2 rear-left, 3 front-left.
 * When armed, stick throttle is floored by min_throttle and motors get a
 * post-mix idle floor so they do not sit at 0 (AirMode idle). ARMING_THROTTLE_MAX
 * remains a separate arm gate. Disarmed callers still force motors to 0 in tasks.
 * Safety S1: PID desaturation instead of per-motor clipping (rule below,
 * docs/SAFETY-NOISE.md) and a saturation flag for the I-term.
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

    /* QUADX: +roll banks right, +pitch raises nose, +yaw CW looking down.
     * u[i] is the PID (differential) part of motor i; each axis column sums
     * to zero over the four motors, so mean(u) == 0. */
    float u[MIXER_MOTOR_COUNT];
    u[0] = -roll + pitch - yaw; /* rear-right */
    u[1] = -roll - pitch + yaw; /* front-right */
    u[2] = +roll + pitch + yaw; /* rear-left */
    u[3] = +roll - pitch - yaw; /* front-left */

    /* Desaturation (safety S1). Motors must stay in [mt, 1]; thr is already
     * in [mt, 1]. With umin/umax the smallest/largest u[i]:
     *  1. If the PID spread does not fit (umax - umin > 1 - mt), scale every
     *     u[i] by (1 - mt) / (umax - umin).
     *  2. If thr + umin < mt, scale every u[i] by (thr - mt) / -umin. The
     *     low side is never fixed by raising throttle: clipping must not
     *     push the average thrust above the commanded throttle.
     *     Consequence (airmode off): at thr == mt the scale is 0, i.e. NO
     *     roll/pitch/yaw correction at min_throttle, and with mt > 0.05 none
     *     for stick between 5 % and mt (stick is floored to mt above).
     *     Exception, only when the user enabled airmode: shift all four
     *     motors up by mt - (thr + umin) instead (airmode keeps full
     *     authority at idle by design; airmode is off by default).
     *  3. If thr + umax > 1, shift all four motors down by the excess. This
     *     keeps the full (already scaled) differential and only lowers the
     *     average below the commanded throttle.
     * Steps 1-2 are uniform scales, so the roll:pitch:yaw ratio (direction
     * of the correction) is kept and the four-motor mean stays exactly thr;
     * after step 3 the mean is below thr. No motor is hard-clipped any more
     * (the final clamp below is only a float-rounding guard).
     * Scaling (steps 1-2) means the PID did not get what it asked for:
     * pid_set_mixer_saturated() then freezes I-term growth (anti-windup).
     * Below the 5 % idle threshold (airmode off) tasks.c zeroes the PID, so
     * u == 0 and nothing here changes; no airmode-style throttle raise. */
    float umin = u[0], umax = u[0];
    for (int i = 1; i < MIXER_MOTOR_COUNT; i++) {
        if (u[i] < umin) umin = u[i];
        if (u[i] > umax) umax = u[i];
    }
    float scale = 1.f;
    const float span = umax - umin;
    if (span > 1.f - mt) {
        scale = (1.f - mt) / span;
    }
    float shift = 0.f;
    if (thr + scale * umin < mt) {
        if (cfg && cfg->airmode) shift = mt - (thr + scale * umin);
        else scale = (thr - mt) / -umin; /* umin < 0 here since thr >= mt */
    }
    if (thr + shift + scale * umax > 1.f) {
        shift = 1.f - (thr + scale * umax);  /* fits: span <= 1 - mt */
    }

    bool clipped = false;
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        const float m = thr + shift + scale * u[i];
        const float c = clampf(m, mt, 1.f);
        if (c != m && fabsf(c - m) > 1e-6f) clipped = true;
        motor_out[i] = c;
    }
    pid_set_mixer_saturated(scale < 1.f || clipped);
}
