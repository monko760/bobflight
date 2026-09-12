/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Clean-room expo rates. Caps and expo from runtime config.
 */
#include "flight/rates.h"
#include "flight/config.h"

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

float rates_curve_map(float stick, float max_rate_dps)
{
    const bf_config_t *cfg = config_get();
    float expo = cfg ? cfg->rate_expo : 0.30f;
    float x = clampf(stick, -1.f, 1.f);
    float ax = x < 0.f ? -x : x;

    if (ax <= RATES_DEADBAND) {
        return 0.f;
    }

    float t = (ax - RATES_DEADBAND) / (1.f - RATES_DEADBAND);
    t = clampf(t, 0.f, 1.f);
    float shaped = t * ((1.f - expo) + expo * t * t);
    if (x < 0.f) {
        shaped = -shaped;
    }
    return shaped * max_rate_dps;
}

void rates_init(void)
{
    config_init();
}

void rates_update(const float rc[4], float setpoint_dps[3])
{
    const bf_config_t *cfg = config_get();
    float mx_r = cfg ? cfg->rate_max_roll : RATES_MAX_DPS;
    float mx_p = cfg ? cfg->rate_max_pitch : RATES_MAX_DPS;
    float mx_y = cfg ? cfg->rate_max_yaw : RATES_MAX_DPS;

    if (!setpoint_dps) {
        return;
    }
    if (!rc) {
        setpoint_dps[0] = setpoint_dps[1] = setpoint_dps[2] = 0.f;
        return;
    }
    setpoint_dps[0] = rates_curve_map(rc[0], mx_r);
    setpoint_dps[1] = rates_curve_map(rc[1], mx_p);
    setpoint_dps[2] = rates_curve_map(rc[2], mx_y);
}
