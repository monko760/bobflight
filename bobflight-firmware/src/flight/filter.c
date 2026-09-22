/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * First-order LPF: alpha = dt/(tau+dt), tau = 1/(2*pi*fc).
 */
#include "flight/filter.h"

#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

float filter_lpf_alpha(float fc_hz, float dt)
{
    if (!(dt > 0.f) || !isfinite(dt) || !isfinite(fc_hz)) {
        return 1.f;
    }
    /* 0 (and negative) = off / passthrough */
    if (fc_hz <= 0.f) {
        return 1.f;
    }
    const float tau = 1.f / (2.f * (float)M_PI * fc_hz);
    return dt / (tau + dt);
}

float filter_lpf_step(float *state, float x, float alpha)
{
    if (!state || !isfinite(x)) {
        return x;
    }
    if (!(alpha > 0.f) || alpha >= 1.f || !isfinite(alpha)) {
        *state = x;
        return x;
    }
    *state += alpha * (x - *state);
    return *state;
}
