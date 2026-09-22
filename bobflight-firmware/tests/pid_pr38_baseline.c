/* Production PID equation mirror for trace bit-exact regression (incl. AW). */
/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "flight/pid.h"
#include "flight/config.h"
#include <math.h>

static float DT = 1.f / 4000.f;
void baseline_pid_set_dt(float dt){if(dt>0.f && dt<0.02f)DT=dt;}
static const float I_LIMIT = 50.f;
static const float OUT_LIMIT = 0.4f;

static float g_i[3];
static float g_prev_err[3];
static float g_deriv[3];
static int g_have_prev;

void baseline_pid_init(void)
{
    g_i[0] = g_i[1] = g_i[2] = 0.f;
    g_prev_err[0] = g_prev_err[1] = g_prev_err[2] = 0.f;
    g_have_prev = 0;
    g_deriv[0]=g_deriv[1]=g_deriv[2]=0;
}

void baseline_pid_update(const float gyro_dps[3], const float setpoint_dps[3],
                pid_axis_out_t *out)
{
    const bf_config_t *cfg = config_get();
    float kp[3], ki[3], kd[3];

    if (!out) {
        return;
    }
    out->roll = 0.f;
    out->pitch = 0.f;
    out->yaw = 0.f;
    if (!gyro_dps || !setpoint_dps || !cfg) {
        return;
    }

    kp[0] = cfg->pid_roll_p;
    ki[0] = cfg->pid_roll_i;
    kd[0] = cfg->pid_roll_d;
    kp[1] = cfg->pid_pitch_p;
    ki[1] = cfg->pid_pitch_i;
    kd[1] = cfg->pid_pitch_d;
    kp[2] = cfg->pid_yaw_p;
    ki[2] = cfg->pid_yaw_i;
    kd[2] = 0.f;

    float axes[3];
    for (int a = 0; a < 3; a++) {
        if(!isfinite(gyro_dps[a]) || !isfinite(setpoint_dps[a])){baseline_pid_init();return;}
        const float err = setpoint_dps[a] - gyro_dps[a];

        float d = 0.f;
        if (g_have_prev) {
            d = -(gyro_dps[a] - g_prev_err[a]) / DT;
        }
        g_prev_err[a] = gyro_dps[a];
        g_deriv[a]+=(DT/(0.003f+DT))*(d-g_deriv[a]);

        const float p_term = kp[a] * err;
        const float d_term = kd[a] * g_deriv[a];
        float i_term = ki[a] * g_i[a];
        float u_pre = p_term + i_term + d_term;
        if (!(fabsf(u_pre) >= OUT_LIMIT && (u_pre * err) > 0.f)) {
            float i_cand = g_i[a] + err * DT;
            if (i_cand > I_LIMIT) {
                i_cand = I_LIMIT;
            } else if (i_cand < -I_LIMIT) {
                i_cand = -I_LIMIT;
            }
            g_i[a] = i_cand;
            i_term = ki[a] * g_i[a];
            u_pre = p_term + i_term + d_term;
        }
        axes[a] = u_pre;
        if(axes[a]>OUT_LIMIT)axes[a]=OUT_LIMIT;
        if(axes[a]< -OUT_LIMIT)axes[a]=-OUT_LIMIT;
    }
    g_have_prev = 1;

    out->roll = axes[0];
    out->pitch = axes[1];
    out->yaw = axes[2];
}
