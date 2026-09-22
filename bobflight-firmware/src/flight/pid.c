/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Rate PID with runtime config gains. The task loop supplies measured PID
 * elapsed time via pid_set_dt; the default is retained for standalone callers.
 */
#include "flight/pid.h"
#include "flight/config.h"
#include <math.h>

static float DT = 1.f / 4000.f;
void pid_set_dt(float dt){if(dt>0.f && dt<0.02f)DT=dt;}
static const float I_LIMIT = 50.f;

static float g_i[3];
static float g_prev_err[3];
static float g_deriv[3];
static int g_have_prev;
static bool g_trace_enabled;
static pid_trace_t g_trace;
void pid_trace_enable(bool enabled){g_trace_enabled=enabled;g_trace=(pid_trace_t){0};}
bool pid_trace_read(pid_trace_t *out){
    if(!out)return false;
    *out=g_trace;
    return g_trace_enabled && g_trace.valid;
}

void pid_init(void)
{
    g_trace=(pid_trace_t){0};
    g_i[0] = g_i[1] = g_i[2] = 0.f;
    g_prev_err[0] = g_prev_err[1] = g_prev_err[2] = 0.f;
    g_have_prev = 0;
    g_deriv[0]=g_deriv[1]=g_deriv[2]=0;
}

void pid_update(const float gyro_dps[3], const float setpoint_dps[3],
                pid_axis_out_t *out)
{
    if(g_trace_enabled)g_trace=(pid_trace_t){0};
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
    kd[2] = 0.f; /* yaw D not in MVP key set */

    float axes[3];
    for (int a = 0; a < 3; a++) {
        if(!isfinite(gyro_dps[a]) || !isfinite(setpoint_dps[a])){pid_init();return;}
        const float err = setpoint_dps[a] - gyro_dps[a];
        g_i[a] += err * DT;
        if (g_i[a] > I_LIMIT) {
            g_i[a] = I_LIMIT;
        } else if (g_i[a] < -I_LIMIT) {
            g_i[a] = -I_LIMIT;
        }

        float d = 0.f;
        if (g_have_prev) {
            d = -(gyro_dps[a] - g_prev_err[a]) / DT;
        }
        g_prev_err[a] = gyro_dps[a];
        g_deriv[a]+=(DT/(0.003f+DT))*(d-g_deriv[a]);

        axes[a] = kp[a] * err + ki[a] * g_i[a] + kd[a] * g_deriv[a];
        if(g_trace_enabled){
            g_trace.dt=DT;g_trace.gyro[a]=gyro_dps[a];g_trace.setpoint[a]=setpoint_dps[a];g_trace.error[a]=err;
            g_trace.p[a]=kp[a]*err;g_trace.i[a]=ki[a]*g_i[a];g_trace.d[a]=kd[a]*g_deriv[a];g_trace.sum[a]=axes[a];
        }
        if(axes[a]>0.4f)axes[a]=0.4f;
        if(axes[a]< -0.4f)axes[a]=-0.4f;
    }
    g_have_prev = 1;

    out->roll = axes[0];
    out->pitch = axes[1];
    out->yaw = axes[2];
    if(g_trace_enabled){
        for(unsigned a=0;a<3;a++)g_trace.output[a]=axes[a];
        g_trace.valid=true;
    }
}
