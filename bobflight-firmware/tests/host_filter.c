/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit checks for soft 1st-order LPF math (Filters R0).
 */
#include "flight/filter.h"
#include "flight/config.h"

#include <math.h>
#include <stdio.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static int fail(const char *m)
{
    fprintf(stderr, "FAIL host_filter: %s\n", m);
    return 1;
}

static int near(float a, float b, float eps)
{
    return fabsf(a - b) <= eps;
}

int main(void)
{
    const float dt = 1.f / 4000.f;

    /* Off / invalid → passthrough alpha */
    if (!near(filter_lpf_alpha(0.f, dt), 1.f, 1e-6f)) {
        return fail("fc=0 should be passthrough");
    }
    if (!near(filter_lpf_alpha(-1.f, dt), 1.f, 1e-6f)) {
        return fail("fc<0 should be passthrough");
    }
    if (!near(filter_lpf_alpha(320.f, 0.f), 1.f, 1e-6f)) {
        return fail("dt<=0 should be passthrough");
    }

    /* Default gyro continuity: fc=320 → α≈0.3345 at dt=1/4000 */
    {
        const float alpha = filter_lpf_alpha(320.f, dt);
        if (!near(alpha, 0.3345f, 5e-4f)) {
            fprintf(stderr, "gyro alpha=%g\n", alpha);
            return fail("gyro default alpha vs legacy 0.3345");
        }
        const float tau = 1.f / (2.f * (float)M_PI * 320.f);
        const float expect = dt / (tau + dt);
        if (!near(alpha, expect, 1e-6f)) {
            return fail("alpha formula mismatch");
        }
    }

    /* Default D-term continuity: fc=53 ≈ τ=0.003 */
    {
        const float alpha = filter_lpf_alpha(53.f, dt);
        const float legacy = dt / (0.003f + dt);
        if (!near(alpha, legacy, 2e-4f)) {
            fprintf(stderr, "dterm alpha=%g legacy=%g\n", alpha, legacy);
            return fail("dterm default alpha vs legacy tau=0.003");
        }
    }

    /* Step: first sample from zero state */
    {
        float st = 0.f;
        const float a = filter_lpf_alpha(320.f, dt);
        const float y = filter_lpf_step(&st, 100.f, a);
        if (!near(y, a * 100.f, 1e-4f) || !near(st, y, 1e-6f)) {
            return fail("first step from zero");
        }
    }

    /* Passthrough step */
    {
        float st = 12.f;
        const float y = filter_lpf_step(&st, 99.f, 1.f);
        if (!near(y, 99.f, 1e-6f) || !near(st, 99.f, 1e-6f)) {
            return fail("passthrough step");
        }
    }

    /* Config defaults + range gates */
    config_init();
    {
        float v;
        if (!config_get_key("gyro_lpf_hz", &v) || !near(v, 320.f, 1e-3f)) {
            return fail("default gyro_lpf_hz");
        }
        if (!config_get_key("dterm_lpf_hz", &v) || !near(v, 53.f, 1e-3f)) {
            return fail("default dterm_lpf_hz");
        }
        if (!config_set_key("gyro_lpf_hz", 0.f) || !config_set_key("dterm_lpf_hz", 0.f)) {
            return fail("set 0=off");
        }
        if (config_set_key("gyro_lpf_hz", 5.f)) {
            return fail("gyro 5 Hz should reject");
        }
        if (config_set_key("dterm_lpf_hz", 1001.f)) {
            return fail("dterm 1001 Hz should reject");
        }
        if (!config_set_key("gyro_lpf_hz", 100.f) || !config_set_key("dterm_lpf_hz", 80.f)) {
            return fail("set in-range");
        }
        config_defaults();
        if (!config_get_key("gyro_lpf_hz", &v) || !near(v, 320.f, 1e-3f)) {
            return fail("defaults restore gyro_lpf_hz");
        }
        if (!config_get_key("dterm_lpf_hz", &v) || !near(v, 53.f, 1e-3f)) {
            return fail("defaults restore dterm_lpf_hz");
        }
    }

    puts("PASS: host filter LPF math + config keys");
    return 0;
}
