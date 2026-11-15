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

    /* Exact cutoff: the measured steady-state gain of the real step function
     * at fc is 1/sqrt(2) at every loop rate (old dt/(tau+dt) form: 0.59 for
     * 320 Hz at 1 kHz, i.e. a real cutoff of 197 Hz). */
    {
        static const float rates[] = {1000.f, 2000.f, 4000.f, 8000.f};
        static const float cuts[] = {53.f, 100.f, 320.f};
        for (unsigned r = 0; r < 4; r++) {
            for (unsigned c = 0; c < 3; c++) {
                const float fs = rates[r], fc = cuts[c];
                const float alpha = filter_lpf_alpha(fc, 1.f / fs);
                float st = 0.f;
                double sq = 0.0;
                const unsigned n = (unsigned)(fs * 2.f); /* 2 s */
                for (unsigned k = 0; k < n; k++) {
                    const float x = sinf(2.f * (float)M_PI * fc * (float)k / fs);
                    const float y = filter_lpf_step(&st, x, alpha);
                    if (k >= n / 2) { /* settled; 1 s = whole cycles */
                        sq += (double)y * (double)y;
                    }
                }
                /* amplitude from RMS (a sampled peak misses the crest) */
                const float peak = (float)sqrt(2.0 * sq / (double)(n / 2));
                if (!near(peak, 0.70711f, 0.004f)) {
                    fprintf(stderr, "fc=%g fs=%g alpha=%g gain=%g\n", fc, fs, alpha, peak);
                    return fail("-3 dB point is not at fc");
                }
            }
        }
        /* Known values of the closed form. */
        if (!near(filter_lpf_alpha(320.f, 1.f / 4000.f), 0.38884f, 2e-4f) ||
            !near(filter_lpf_alpha(53.f, 1.f / 4000.f), 0.07984f, 2e-4f)) {
            fprintf(stderr, "alpha 320@4k=%g 53@4k=%g\n",
                    filter_lpf_alpha(320.f, 1.f / 4000.f), filter_lpf_alpha(53.f, 1.f / 4000.f));
            return fail("closed-form alpha values");
        }
        /* Monotonic in fc, and passthrough at/above Nyquist. */
        float prev = 0.f;
        for (float fc = 10.f; fc < 500.f; fc += 10.f) {
            const float a = filter_lpf_alpha(fc, 1.f / 1000.f);
            if (!(a > prev) || !(a < 1.f)) {
                return fail("alpha must rise with fc below Nyquist");
            }
            prev = a;
        }
        if (!near(filter_lpf_alpha(500.f, 1.f / 1000.f), 1.f, 1e-6f) ||
            !near(filter_lpf_alpha(1000.f, 1.f / 1000.f), 1.f, 1e-6f)) {
            return fail("at/above Nyquist must be passthrough");
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
