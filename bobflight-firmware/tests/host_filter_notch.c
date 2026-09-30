/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Manual gyro notch (schema 8): RBJ-cookbook biquad notch, Q from centre and
 * lower -3 dB edge, the 2 x 3-axis bank used by drivers/gyro.c, and the
 * config pair rule. Response is measured two ways: the analytic |H(e^jw)| of
 * the float coefficients, and a float time-domain run (the code that flies). */
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
#include "flight/filter.h"
#include "flight/config.h"

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static double gain_db_analytic(const filter_biquad_t *c, double f, double fs)
{
    const double w = 2.0 * M_PI * f / fs;
    const double cr = cos(w), ci = -sin(w), c2r = cos(2 * w), c2i = -sin(2 * w);
    const double nr = c->b0 + c->b1 * cr + c->b2 * c2r, ni = c->b1 * ci + c->b2 * c2i;
    const double dr = 1.0 + c->a1 * cr + c->a2 * c2r, di = c->a1 * ci + c->a2 * c2i;
    return 10.0 * log10((nr * nr + ni * ni) / (dr * dr + di * di));
}

/* Steady-state RMS gain of a float sine run through the biquad. */
static double gain_db_time(const filter_biquad_t *c, double f, double fs)
{
    filter_biquad_state_t s = {0.f, 0.f};
    const int settle = (int)(fs * 0.5), n = (int)(fs * 0.5);
    double in2 = 0, out2 = 0;
    for (int i = 0; i < settle + n; i++) {
        const float x = (float)sin(2.0 * M_PI * f * i / fs);
        const float y = filter_biquad_step(c, &s, x);
        if (i >= settle) { in2 += (double)x * x; out2 += (double)y * y; }
    }
    return 10.0 * log10((out2 + 1e-30) / in2);
}

static void check_response(float f0, float fc, float fs)
{
    filter_biquad_t c;
    assert(filter_biquad_notch(&c, f0, fc, fs));
    const double center_a = gain_db_analytic(&c, f0, fs), center_t = gain_db_time(&c, f0, fs);
    assert(center_a <= -30.0 && center_t <= -30.0);
    /* -3 dB edges: lower edge fc, upper f0^2/fc (bilinear warping moves them a little). */
    const double lo = gain_db_analytic(&c, fc, fs);
    /* The formula's Q is analog-domain; bilinear warping narrows the band as
     * f0 nears Nyquist (at 1 kHz), so the lower edge sits at -3 dB or less. */
    assert(lo <= -0.3 && lo >= -3.5);
    if (fs >= 4000.f && f0 <= 600.f) assert(fabs(lo + 3.0) <= 0.6);
    /* Well outside the band (below half the lower edge, above 3x the upper
     * edge f0^2/fc or at the 0.45*fs limit): <= 1 dB error vs 0 dB. */
    const double below = f0 / 4.0 < fc / 2.0 ? f0 / 4.0 : fc / 2.0;
    const double above_ideal = 3.0 * (double)f0 * f0 / fc, cap = 0.45 * fs;
    const double above = above_ideal < cap ? above_ideal : cap;
    const double gb_a = gain_db_analytic(&c, below, fs), gb_t = gain_db_time(&c, below, fs);
    const double ga_a = gain_db_analytic(&c, above, fs), ga_t = gain_db_time(&c, above, fs);
    assert(fabs(gb_a) <= 1.0 && fabs(gb_t) <= 1.0);
    assert(fabs(ga_a) <= 1.0 && fabs(ga_t) <= 1.0);

    assert(fabs(gain_db_analytic(&c, 1.0, fs)) <= 0.05); /* ~DC */
    printf("  fs=%5.0f f0=%6.1f fc=%6.1f Q=%.3f: centre %.1f dB (time %.1f), %.0f Hz %.3f dB, %.0f Hz %.3f dB, edge %.2f dB\n",
           fs, f0, fc, filter_notch_q(f0, fc), center_a, center_t, below, gb_a, above, ga_a, lo);
}

int main(void)
{
    setvbuf(stdout, NULL, _IONBF, 0);
    /* Q = f0*fc/(f0^2 - fc^2) */
    assert(fabsf(filter_notch_q(200.f, 150.f) - 200.f * 150.f / (40000.f - 22500.f)) < 1e-5f);
    assert(filter_notch_q(0.f, 0.f) == 0.f && filter_notch_q(200.f, 200.f) == 0.f && filter_notch_q(200.f, 0.f) == 0.f);
    assert(filter_notch_q(19.f, 10.f) == 0.f && filter_notch_q(1001.f, 900.f) == 0.f);

    /* Frequency response at the three loop rates (gyro filter runs at PID cadence). */
    const float rates[3] = {1000.f, 4000.f, 8000.f};
    for (unsigned r = 0; r < 3; r++) {
        check_response(200.f, 150.f, rates[r]);
        check_response(120.f, 80.f, rates[r]);
        check_response(300.f, 250.f, rates[r]);
    }
    check_response(400.f, 300.f, 1000.f);  /* just below the 450 Hz limit at 1 kHz */
    check_response(1000.f, 800.f, 4000.f);
    check_response(1000.f, 800.f, 8000.f);
    check_response(20.f, 10.f, 8000.f);    /* lowest centre at the fastest rate */
    check_response(600.f, 500.f, 4000.f);

    /* Nyquist margin: centre must be < 0.45 * fs. */
    filter_biquad_t c;
    assert(filter_notch_center_limit_hz(1000.f) == 450.f && filter_notch_center_limit_hz(4000.f) == 1800.f);
    assert(!filter_biquad_notch(&c, 600.f, 400.f, 1000.f) && c.b0 == 1.f && c.a1 == 0.f);
    assert(!filter_biquad_notch(&c, 450.f, 300.f, 1000.f));
    assert(filter_biquad_notch(&c, 449.f, 300.f, 1000.f));
    assert(filter_notch_evaluate(0.f, 0.f, 0.001f) == FILTER_NOTCH_OFF);
    assert(filter_notch_evaluate(0.f, 150.f, 0.001f) == FILTER_NOTCH_OFF);
    assert(filter_notch_evaluate(600.f, 400.f, 0.001f) == FILTER_NOTCH_ABOVE_NYQUIST);
    assert(filter_notch_evaluate(600.f, 400.f, 0.00025f) == FILTER_NOTCH_OK);
    assert(filter_notch_evaluate(200.f, 250.f, 0.00025f) == FILTER_NOTCH_INVALID);
    assert(filter_notch_evaluate(200.f, 150.f, 0.f) == FILTER_NOTCH_INVALID);
    assert(!strcmp(filter_notch_reason_name(FILTER_NOTCH_ABOVE_NYQUIST), "above-nyquist"));
    assert(!strcmp(filter_notch_reason_name(FILTER_NOTCH_OFF), "off") && !strcmp(filter_notch_reason_name(FILTER_NOTCH_OK), "ok") &&
           !strcmp(filter_notch_reason_name(FILTER_NOTCH_INVALID), "invalid"));

    /* Bank: recompute on dt change only, runtime disable above Nyquist, settings untouched. */
    filter_notch_bank_t b;
    filter_notch_bank_init(&b);
    float center[2] = {200.f, 600.f}, cutoff[2] = {150.f, 420.f};
    const float center_copy[2] = {200.f, 600.f}, cutoff_copy[2] = {150.f, 420.f};
    assert(filter_notch_bank_update(&b, center, cutoff, 1.f / 4000.f) && b.recomputes == 1);
    assert(b.reason[0] == FILTER_NOTCH_OK && b.reason[1] == FILTER_NOTCH_OK);
    filter_biquad_t at4k = b.coeff[0];
    assert(!filter_notch_bank_update(&b, center, cutoff, 1.f / 4000.f) && b.recomputes == 1); /* no change -> no work */
    assert(filter_notch_bank_update(&b, center, cutoff, 1.f / 8000.f) && b.recomputes == 2);
    assert(b.coeff[0].a1 != at4k.a1 && b.reason[1] == FILTER_NOTCH_OK);
    filter_biquad_t ref;
    assert(filter_biquad_notch(&ref, 200.f, 150.f, 8000.f) && !memcmp(&ref, &b.coeff[0], sizeof ref));
    /* Loop falls to 1 kHz (guard/setting): notch2 at 600 Hz is disabled at runtime and reported. */
    assert(filter_notch_bank_update(&b, center, cutoff, 1.f / 1000.f) && b.recomputes == 3);
    assert(b.reason[0] == FILTER_NOTCH_OK && b.reason[1] == FILTER_NOTCH_ABOVE_NYQUIST);
    assert(b.coeff[1].b0 == 1.f && b.coeff[1].b1 == 0.f && b.coeff[1].a1 == 0.f && b.coeff[1].a2 == 0.f);
    assert(!memcmp(center, center_copy, sizeof center) && !memcmp(cutoff, cutoff_copy, sizeof cutoff));
    {   /* The disabled notch is exact passthrough; notch1 still removes 200 Hz on every axis. */
        float in2[3] = {0}, out2[3] = {0};
        for (int i = 0; i < 3000; i++) {
            float v[3];
            for (unsigned a = 0; a < 3; a++) v[a] = (float)(sin(2 * M_PI * 200.0 * i / 1000.0 + a) + 0.5 * a);
            float x[3]; memcpy(x, v, sizeof x);
            filter_notch_bank_apply(&b, v);
            if (i >= 1500) for (unsigned a = 0; a < 3; a++) { in2[a] += (x[a] - 0.5f * a) * (x[a] - 0.5f * a); out2[a] += (v[a] - 0.5f * a) * (v[a] - 0.5f * a); }
        }
        for (unsigned a = 0; a < 3; a++) assert(10.0 * log10(out2[a] / in2[a]) <= -30.0);
    }
    /* Back to 4 kHz: re-enabled with 4 kHz coefficients. */
    assert(filter_notch_bank_update(&b, center, cutoff, 1.f / 4000.f) && b.reason[1] == FILTER_NOTCH_OK);
    assert(!memcmp(&b.coeff[0], &at4k, sizeof at4k));
    /* Setting change also recomputes; off is exact passthrough. */
    center[0] = 0.f;
    assert(filter_notch_bank_update(&b, center, cutoff, 1.f / 4000.f) && b.reason[0] == FILTER_NOTCH_OFF);
    center[1] = 0.f;
    assert(filter_notch_bank_update(&b, center, cutoff, 1.f / 4000.f));
    { float v[3] = {1.25f, -3.5f, 1e6f}; filter_notch_bank_apply(&b, v); assert(v[0] == 1.25f && v[1] == -3.5f && v[2] == 1e6f); }
    /* Priming: enabling on a constant input gives no step transient. */
    center[0] = 200.f;
    assert(filter_notch_bank_update(&b, center, cutoff, 1.f / 4000.f));
    for (int i = 0; i < 50; i++) { float v[3] = {100.f, -50.f, 7.f}; filter_notch_bank_apply(&b, v); assert(fabsf(v[0] - 100.f) < 1e-3f && fabsf(v[1] + 50.f) < 1e-3f && fabsf(v[2] - 7.f) < 1e-4f); }
    /* Non-finite input never poisons the state. */
    { float v[3] = {NAN, INFINITY, 1.f}; filter_notch_bank_apply(&b, v); assert(isnan(v[0]) && isinf(v[1])); }
    { float v[3] = {100.f, -50.f, 7.f}; filter_notch_bank_apply(&b, v); assert(fabsf(v[0] - 100.f) < 1e-2f && isfinite(v[1])); }

    /* Config pair rule and key access (CLI/persist validation domain). */
    config_init();
    float g = -1.f;
    const char *keys[4] = {"gyro_notch1_hz", "gyro_notch1_cutoff_hz", "gyro_notch2_hz", "gyro_notch2_cutoff_hz"};
    for (unsigned i = 0; i < 4; i++) assert(config_get_key(keys[i], &g) && g == 0.f);
    assert(!config_set_key("gyro_notch1_hz", 200.f));          /* needs a cutoff first */
    assert(config_set_key("gyro_notch1_cutoff_hz", 150.f));    /* centre 0: cutoff stored, inert */
    assert(config_set_key("gyro_notch1_hz", 200.f));
    assert(!config_set_key("gyro_notch1_cutoff_hz", 200.f) && !config_set_key("gyro_notch1_cutoff_hz", 0.f));
    assert(!config_set_key("gyro_notch1_cutoff_hz", -1.f));
    assert(!config_set_key("gyro_notch1_hz", 140.f));          /* below its cutoff */
    assert(!config_set_key("gyro_notch1_hz", 19.9f) && !config_set_key("gyro_notch1_hz", 1000.5f));
    assert(!config_set_key("gyro_notch1_hz", NAN) && !config_set_key("gyro_notch1_hz", -200.f));
    assert(config_get_key("gyro_notch1_hz", &g) && g == 200.f);
    assert(config_set_key("gyro_notch1_hz", 0.f));             /* off keeps the cutoff */
    assert(config_get_key("gyro_notch1_cutoff_hz", &g) && g == 150.f);
    assert(!config_set_key("gyro_notch2_cutoff_hz", 1000.f) && config_set_key("gyro_notch2_cutoff_hz", 999.f));
    assert(config_set_key("gyro_notch2_hz", 1000.f));
    assert(!config_set_key("gyro_notch3_hz", 0.f) && !config_get_key("gyro_notch3_hz", &g) && !config_get_key("gyro_notch1", &g));
    assert(config_set_gyro_notch(2, 300.f, 250.f) && !config_set_gyro_notch(2, 300.f, 300.f) && !config_set_gyro_notch(3, 0.f, 0.f));
    assert(config_get_key("gyro_notch2_hz", &g) && g == 300.f);
    config_defaults();
    for (unsigned i = 0; i < 4; i++) assert(config_get_key(keys[i], &g) && g == 0.f);
    puts("PASS gyro notch: RBJ biquad >=30 dB at centre and <=1 dB well outside at 1k/4k/8k, Q from cutoff, "
         "dt-change recompute, above-nyquist runtime disable (settings untouched), priming, pair rule");
    return 0;
}
