/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Actual rates only. Independent per-axis center, maximum and expo.
 */
#include "flight/rates.h"
#include "flight/config.h"
#include <math.h>

static const float RATES_DEADBAND = 0.02f;

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

float rates_actual_map(float stick, float center, float max_rate, float expo)
{
    if (!isfinite(stick) || !isfinite(center) || !isfinite(max_rate) || !isfinite(expo) || center<0.f || center>2000.f || max_rate<10.f || max_rate>2000.f || expo<0.f || expo>1.f) {
        return 0.f;
    }
    float x = clampf(stick, -1.f, 1.f);
    float ax = fabsf(x);
    float ax2 = ax * ax;
    float ax5 = ax2 * ax2 * ax;
    float m_minus_c = max_rate - center;
    float m_c = m_minus_c > 0.f ? m_minus_c : 0.f;
    float shape = (1.f - expo) * ax + expo * ax5;
    return center * x + m_c * x * shape;
}

void rates_init(void)
{
    config_init();
}

void rates_update(const float rc[4], float setpoint_dps[3])
{
    if (!setpoint_dps) {
        return;
    }
    if (!rc) {
        setpoint_dps[0] = setpoint_dps[1] = setpoint_dps[2] = 0.f;
        return;
    }
    const bf_config_t *cfg = config_get();
    {
        float center[3] = { cfg->rate_center_roll, cfg->rate_center_pitch, cfg->rate_center_yaw };
        float max_r[3] = { cfg->rate_max_roll, cfg->rate_max_pitch, cfg->rate_max_yaw };
        float expo[3] = { cfg->rate_expo_roll, cfg->rate_expo_pitch, cfg->rate_expo_yaw };

        for (int i = 0; i < 3; i++) {
            float stick = rc[i];
            if (!isfinite(stick)) {
                setpoint_dps[i] = 0.f;
                continue;
            }
            float x = clampf(stick, -1.f, 1.f);
            float ax = fabsf(x);
            if (ax <= RATES_DEADBAND) {
                setpoint_dps[i] = 0.f;
            } else {
                float t = (ax - RATES_DEADBAND) / (1.f - RATES_DEADBAND);
                t = clampf(t, 0.f, 1.f);
                float x_post = (x < 0.f) ? -t : t;
                setpoint_dps[i] = rates_actual_map(x_post, center[i], max_r[i], expo[i]);
            }
        }
    }
}
