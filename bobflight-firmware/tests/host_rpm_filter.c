/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * RPM notch filter logic + DSP (flight/rpm_filter.c): fundamental from eRPM and
 * poles, harmonic trim per loop rate, reason precedence, per-motor bypass,
 * min_hz hold, runtime Nyquist bypass, crossfade without a step transient,
 * round-robin coefficient updates, recurrence == direct coefficients, and the
 * notch depth / passband at 1 kHz, 4 kHz and 8 kHz. */
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "flight/rpm_filter.h"

static const float PI_F = 3.14159265358979f;
static rpm_filter_settings_t S(unsigned h, float min_hz, float q, unsigned poles)
{
    rpm_filter_settings_t s = {h, min_hz, q, poles};
    return s;
}
static rpm_filter_input_t IN(bool bidir, uint32_t e1, uint32_t e2, uint32_t e3, uint32_t e4)
{
    rpm_filter_input_t in;
    memset(&in, 0, sizeof in);
    in.bidir = bidir;
    const uint32_t e[4] = {e1, e2, e3, e4};
    for (unsigned m = 0; m < 4; m++) { in.erpm[m] = e[m]; in.valid[m] = bidir && e[m] > 0u; }
    return in;
}
/* eRPM for a mechanical frequency with 14 poles (7 pole pairs). */
static uint32_t erpm14(float hz) { return (uint32_t)lroundf(hz * 7.f * 60.f); }

/* Steady-state gain (dB) of the bank for a sine at f, all three axes, after warm-up. */
static float gain_db(rpm_filter_bank_t *b, const rpm_filter_settings_t *s, const rpm_filter_input_t *in, float fs, float f)
{
    const unsigned n = (unsigned)(fs * 0.6f), warm = (unsigned)(fs * 0.3f);
    double in_e = 0, out_e = 0;
    for (unsigned i = 0; i < n; i++) {
        const float x = sinf(2.f * PI_F * f * (float)i / fs);
        float v[3] = {x, 0.5f * x, -x};
        rpm_filter_update(b, s, in, 1.f / fs);
        rpm_filter_apply(b, v);
        if (i >= warm) { in_e += (double)x * x; out_e += (double)v[0] * v[0]; }
    }
    return (float)(10.0 * log10(out_e / in_e));
}

int main(void)
{
    /* Fundamental and trim. */
    assert(fabsf(rpm_filter_fundamental_hz(42000u, 14u) - 100.f) < 1e-3f);
    assert(fabsf(rpm_filter_fundamental_hz(42000u, 12u) - 116.6667f) < 1e-2f);
    assert(rpm_filter_fundamental_hz(0u, 14u) == 0.f && rpm_filter_fundamental_hz(1000u, 13u) == 0.f && rpm_filter_fundamental_hz(1000u, 0u) == 0.f);
    assert(rpm_filter_allowed_harmonics(1000.f) == 1u);
    assert(rpm_filter_allowed_harmonics(2000.f) == 2u);
    assert(rpm_filter_allowed_harmonics(4000.f) == 3u);
    assert(rpm_filter_allowed_harmonics(8000.f) == 3u);
    assert(rpm_filter_allowed_harmonics(0.f) == 0u && rpm_filter_allowed_harmonics(NAN) == 0u);
    puts("PASS fundamental = eRPM/(poles/2)/60; harmonics allowed 1@1k, 2@2k, 3@4k/8k");

    /* Reason precedence: off > bidir-off > erpm-unavailable > ok. */
    {
        rpm_filter_input_t off = IN(false, 0, 0, 0, 0), none = IN(true, 0, 0, 0, 0), one = IN(true, 0, 0, 42000u, 0);
        assert(rpm_filter_evaluate(0u, &off) == RPM_FILTER_OFF);
        assert(rpm_filter_evaluate(0u, &one) == RPM_FILTER_OFF);
        assert(rpm_filter_evaluate(2u, &off) == RPM_FILTER_BIDIR_OFF);
        assert(rpm_filter_evaluate(2u, &none) == RPM_FILTER_ERPM_UNAVAILABLE);
        assert(rpm_filter_evaluate(2u, &one) == RPM_FILTER_OK);
        rpm_filter_input_t stale = IN(true, 0, 0, 0, 0);
        stale.erpm[1] = 42000u; stale.valid[1] = false;       /* telem not OK: value ignored */
        assert(rpm_filter_evaluate(2u, &stale) == RPM_FILTER_ERPM_UNAVAILABLE);
        rpm_filter_input_t zero = IN(true, 0, 0, 0, 0);
        zero.valid[0] = true;                                 /* OK but 0 eRPM */
        assert(rpm_filter_evaluate(2u, &zero) == RPM_FILTER_ERPM_UNAVAILABLE);
        off.valid[0] = true; off.erpm[0] = 42000u;            /* bidir off wins over stale values */
        assert(rpm_filter_evaluate(3u, &off) == RPM_FILTER_BIDIR_OFF);
        assert(!strcmp(rpm_filter_reason_name(RPM_FILTER_OFF), "off") && !strcmp(rpm_filter_reason_name(RPM_FILTER_BIDIR_OFF), "bidir-off") &&
               !strcmp(rpm_filter_reason_name(RPM_FILTER_ERPM_UNAVAILABLE), "erpm-unavailable") && !strcmp(rpm_filter_reason_name(RPM_FILTER_OK), "ok"));
        puts("PASS reason precedence off > bidir-off > erpm-unavailable > ok; stale/zero eRPM is not valid");
    }

    /* Depth at each harmonic and passband, 1k/4k/8k. */
    {
        const float rates[3] = {1000.f, 4000.f, 8000.f};
        for (unsigned r = 0; r < 3; r++) {
            const float fs = rates[r], f0 = 150.f;
            rpm_filter_settings_t s = S(3u, 100.f, 5.f, 14u);
            rpm_filter_input_t in = IN(true, erpm14(f0), 0, 0, 0);
            const unsigned active = rpm_filter_allowed_harmonics(fs);
            for (unsigned h = 1; h <= active; h++) {
                rpm_filter_bank_t b; rpm_filter_init(&b);
                const float fh = (float)h * (float)erpm14(f0) / 420.f;
                const float g = gain_db(&b, &s, &in, fs, fh);
                assert(b.reason == RPM_FILTER_OK && b.harmonics_active == active);
                assert(g < -30.f);
            }
            rpm_filter_bank_t b; rpm_filter_init(&b);
            const float pass = gain_db(&b, &s, &in, fs, 30.f);
            assert(pass > -0.5f && pass < 0.1f);
            printf("  fs=%g: %u harmonics, passband 30 Hz %.2f dB\n", (double)fs, active, (double)pass);
        }
        puts("PASS notch depth < -30 dB at every active harmonic, passband within 0.5 dB (1k/4k/8k)");
    }

    /* Harmonic trim at 1 kHz: setting 3, one runs, reason stays ok. */
    {
        rpm_filter_bank_t b; rpm_filter_init(&b);
        rpm_filter_settings_t s = S(3u, 100.f, 5.f, 14u);
        rpm_filter_input_t in = IN(true, erpm14(150.f), 0, 0, 0);
        rpm_filter_update(&b, &s, &in, 0.001f);
        assert(b.reason == RPM_FILTER_OK && b.harmonics_active == 1u);
        assert(b.want[0][0] && !b.want[0][1] && !b.want[0][2]);
        puts("PASS 1 kHz trims harmonics 3 -> 1 (reason ok)");
    }

    /* min_hz hold, per-motor state, runtime Nyquist bypass. */
    {
        rpm_filter_bank_t b; rpm_filter_init(&b);
        rpm_filter_settings_t s = S(2u, 120.f, 5.f, 14u);
        rpm_filter_input_t in = IN(true, erpm14(40.f), erpm14(300.f), 0, erpm14(460.f));
        rpm_filter_update(&b, &s, &in, 0.001f);
        assert(b.reason == RPM_FILTER_OK && b.harmonics_active == 1u);
        assert(b.motor_valid[0] && fabsf(b.fund_hz[0] - 120.f) < 1e-3f);   /* held at min_hz */
        assert(b.motor_valid[1] && fabsf(b.fund_hz[1] - 300.f) < 0.1f && b.want[1][0]);
        assert(!b.motor_valid[2] && !b.want[2][0]);
        assert(b.motor_valid[3] && !b.want[3][0]);   /* 460 Hz >= 450 at 1 kHz: bypassed, not reported */
        puts("PASS min_hz hold, per-motor validity, per-notch bypass at >= 0.45 fs");
    }

    /* Fade in without a step transient; fade out to an exact passthrough. */
    {
        const float fs = 4000.f, dt = 1.f / fs;
        rpm_filter_bank_t b; rpm_filter_init(&b);
        rpm_filter_settings_t s = S(3u, 100.f, 5.f, 14u);
        rpm_filter_input_t on = IN(true, erpm14(200.f), erpm14(210.f), erpm14(220.f), erpm14(230.f));
        rpm_filter_input_t off = IN(true, 0, 0, 0, 0);
        const unsigned fade = (unsigned)lroundf(RPM_FILTER_FADE_S * fs);
        for (unsigned i = 0; i < fade + 4u; i++) {
            float v[3] = {10.f, -3.f, 0.25f};
            rpm_filter_update(&b, &s, &on, dt);
            rpm_filter_apply(&b, v);
            assert(fabsf(v[0] - 10.f) < 1e-3f && fabsf(v[1] + 3.f) < 1e-3f && fabsf(v[2] - 0.25f) < 1e-4f); /* primed: DC passes */
            if (i == 0u) assert(fabsf(b.weight[0][0] - 1.f / (float)fade) < 1e-5f);
        }
        assert(b.weight[0][0] == 1.f && b.weight[3][2] == 1.f && rpm_filter_running(&b) == 12u);
        /* all motors lose eRPM: erpm-unavailable at once, notches fade out */
        rpm_filter_update(&b, &s, &off, dt);
        assert(b.reason == RPM_FILTER_ERPM_UNAVAILABLE && b.harmonics_active == 0u && !b.motor_valid[0]);
        for (unsigned i = 0; i < fade; i++) { float v[3] = {1.f, 2.f, 3.f}; rpm_filter_update(&b, &s, &off, dt); rpm_filter_apply(&b, v); }
        assert(rpm_filter_running(&b) == 0u);
        for (unsigned i = 0; i < 16u; i++) {
            float v[3] = {sinf((float)i), 2.f * cosf((float)i), -1.5f}, x[3];
            memcpy(x, v, sizeof x);
            rpm_filter_update(&b, &s, &off, dt);
            rpm_filter_apply(&b, v);
            assert(!memcmp(v, x, sizeof x));   /* bit-exact passthrough */
        }
        /* harmonics 0 -> off, also passthrough */
        rpm_filter_settings_t z = S(0u, 100.f, 5.f, 14u);
        rpm_filter_update(&b, &z, &on, dt);
        assert(b.reason == RPM_FILTER_OFF && rpm_filter_running(&b) == 0u);
        puts("PASS crossfade in (primed, no step) / out over RPM_FILTER_FADE_S; bypass is bit-exact");
    }

    /* Round-robin coefficient updates; all motors on dt/setting change or start. */
    {
        rpm_filter_bank_t b; rpm_filter_init(&b);
        rpm_filter_settings_t s = S(3u, 100.f, 5.f, 14u);
        rpm_filter_input_t in = IN(true, erpm14(200.f), erpm14(210.f), erpm14(220.f), erpm14(230.f));
        rpm_filter_update(&b, &s, &in, 0.00025f);
        assert(b.coeff_updates == 4u);                    /* first configure: all */
        for (unsigned i = 0; i < 8u; i++) rpm_filter_update(&b, &s, &in, 0.00025f);
        assert(b.coeff_updates == 12u);                   /* one motor per sample */
        rpm_filter_update(&b, &s, &in, 0.000125f);
        assert(b.coeff_updates == 16u);                   /* dt change: all */
        s.q = 3.f; rpm_filter_update(&b, &s, &in, 0.000125f);
        assert(b.coeff_updates == 20u);                   /* setting change: all */
        /* recurrence == direct sin/cos of h*w */
        const float w = 2.f * PI_F * b.fund_hz[b.rr == 0u ? 3u : b.rr - 1u] * 0.000125f;
        const unsigned m = b.rr == 0u ? 3u : b.rr - 1u;
        for (unsigned h = 0; h < 3u; h++) {
            filter_biquad_t d;
            assert(rpm_filter_notch_coeff(&d, cosf((float)(h + 1u) * w), sinf((float)(h + 1u) * w), 3.f));
            assert(fabsf(d.b0 - b.coeff[m][h].b0) < 1e-5f && fabsf(d.b1 - b.coeff[m][h].b1) < 1e-5f && fabsf(d.a2 - b.coeff[m][h].a2) < 1e-5f);
        }
        filter_biquad_t bad;
        assert(!rpm_filter_notch_coeff(&bad, 1.f, 0.f, 5.f) && bad.b0 == 1.f && bad.b1 == 0.f);
        assert(!rpm_filter_notch_coeff(&bad, 0.5f, 0.5f, 0.f));
        puts("PASS round-robin 1 motor/sample, all on dt/setting change; recurrence == direct; bad input -> passthrough");
    }

    /* A tracked frequency change keeps following the motor (4 kHz sweep 150 -> 300 Hz). */
    {
        const float fs = 4000.f;
        rpm_filter_bank_t b; rpm_filter_init(&b);
        rpm_filter_settings_t s = S(1u, 100.f, 5.f, 14u);
        double ph = 0, in_e = 0, out_e = 0;
        for (unsigned i = 0; i < 8000u; i++) {
            const float f = 150.f + 150.f * (float)i / 8000.f;
            rpm_filter_input_t in = IN(true, erpm14(f), 0, 0, 0);
            ph += 2.0 * 3.14159265358979 * f / fs;
            const float x = (float)sin(ph);
            float v[3] = {x, x, x};
            rpm_filter_update(&b, &s, &in, 1.f / fs);
            rpm_filter_apply(&b, v);
            assert(isfinite(v[0]) && fabsf(v[0]) < 2.f);
            if (i > 400u) { in_e += (double)x * x; out_e += (double)v[0] * v[0]; }
        }
        const double g = 10.0 * log10(out_e / in_e);
        printf("  sweep 150->300 Hz tracked: %.1f dB\n", g);
        assert(g < -20.0);
        float nanv[3] = {NAN, 1.f, 1.f};
        rpm_filter_input_t in = IN(true, erpm14(300.f), 0, 0, 0);
        rpm_filter_update(&b, &s, &in, 1.f / fs);
        rpm_filter_apply(&b, nanv);
        assert(isnan(nanv[0]) && isfinite(nanv[1]));
        puts("PASS tracking sweep stays attenuated and bounded; non-finite axis skipped");
    }
    puts("PASS rpm_filter");
    return 0;
}
