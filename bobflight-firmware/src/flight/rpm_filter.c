/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * RPM notch filter logic; see flight/rpm_filter.h and docs/RPM-FILTER.md.
 * Clean-room; no Betaflight source.
 */
#include "flight/rpm_filter.h"
#include <math.h>
#include <string.h>

#define RPM_PI 3.14159265358979f

const char *rpm_filter_reason_name(rpm_filter_reason_t r)
{
    switch (r) {
    case RPM_FILTER_OFF: return "off";
    case RPM_FILTER_BIDIR_OFF: return "bidir-off";
    case RPM_FILTER_ERPM_UNAVAILABLE: return "erpm-unavailable";
    case RPM_FILTER_OK: return "ok";
    default: return "invalid";
    }
}

float rpm_filter_fundamental_hz(uint32_t erpm, unsigned poles)
{
    if (erpm == 0u || poles < 2u || (poles & 1u)) return 0.f;
    return (float)erpm / ((float)(poles / 2u) * 60.f);
}

unsigned rpm_filter_allowed_harmonics(float sample_hz)
{
    if (!isfinite(sample_hz) || sample_hz <= 0.f) return 0u;
    const float limit = FILTER_NOTCH_NYQUIST_MARGIN * 0.5f * sample_hz;
    unsigned n = 0u;
    for (unsigned h = 1u; h <= RPM_FILTER_MAX_HARMONICS; h++)
        if ((float)h * RPM_FILTER_TOP_FUND_HZ < limit) n = h;
    return n;
}

static bool motor_input_valid(const rpm_filter_input_t *in, unsigned m)
{
    return in->bidir && in->valid[m] && in->erpm[m] > 0u;
}

rpm_filter_reason_t rpm_filter_evaluate(unsigned harmonics, const rpm_filter_input_t *in)
{
    if (harmonics == 0u) return RPM_FILTER_OFF;
    if (!in || !in->bidir) return RPM_FILTER_BIDIR_OFF;
    for (unsigned m = 0; m < RPM_FILTER_MOTORS; m++)
        if (motor_input_valid(in, m)) return RPM_FILTER_OK;
    return RPM_FILTER_ERPM_UNAVAILABLE;
}

bool rpm_filter_notch_coeff(filter_biquad_t *c, float cos_w0, float sin_w0, float q)
{
    if (!c) return false;
    filter_biquad_passthrough(c);
    if (!isfinite(cos_w0) || !isfinite(sin_w0) || !isfinite(q) || q <= 0.f || sin_w0 <= 0.f) return false;
    const float alpha = sin_w0 / (2.f * q);
    const float inv = 1.f / (1.f + alpha);
    const filter_biquad_t n = {inv, -2.f * cos_w0 * inv, inv, -2.f * cos_w0 * inv, (1.f - alpha) * inv};
    if (!isfinite(n.b0) || !isfinite(n.b1) || !isfinite(n.a2)) return false;
    *c = n;
    return true;
}

void rpm_filter_init(rpm_filter_bank_t *b)
{
    if (!b) return;
    memset(b, 0, sizeof *b);
    for (unsigned m = 0; m < RPM_FILTER_MOTORS; m++)
        for (unsigned h = 0; h < RPM_FILTER_MAX_HARMONICS; h++) filter_biquad_passthrough(&b->coeff[m][h]);
}

/* One sin/cos for the motor, harmonics by recurrence. Only notches that should
 * run get new coefficients; a fading-out notch keeps its last ones. */
static void motor_coeffs(rpm_filter_bank_t *b, unsigned m)
{
    const float w = 2.f * RPM_PI * b->fund_hz[m] * b->dt;
    const float s1 = sinf(w), c1 = cosf(w);
    const float c2 = 2.f * c1 * c1 - 1.f, s2 = 2.f * s1 * c1;
    const float cs[RPM_FILTER_MAX_HARMONICS][2] = {{c1, s1}, {c2, s2}, {2.f * c1 * c2 - c1, s1 * c2 + c1 * s2}};
    for (unsigned h = 0; h < RPM_FILTER_MAX_HARMONICS; h++) {
        if (!b->want[m][h]) continue;
        if (!rpm_filter_notch_coeff(&b->coeff[m][h], cs[h][0], cs[h][1], b->set.q)) {
            b->want[m][h] = false;      /* unusable: fade out on passthrough */
            b->prime[m][h] = false;
        }
    }
    b->coeff_updates++;
}

void rpm_filter_update(rpm_filter_bank_t *b, const rpm_filter_settings_t *s, const rpm_filter_input_t *in, float dt)
{
    if (!b || !s || !in) return;
    const bool dt_ok = isfinite(dt) && dt > 0.f;
    const float fs = dt_ok ? 1.f / dt : 0.f;
    const bool all = !b->configured || dt != b->dt || s->harmonics != b->set.harmonics || s->min_hz != b->set.min_hz ||
                     s->q != b->set.q || s->poles != b->set.poles;
    b->set = *s;
    b->dt = dt;
    b->configured = true;
    b->reason = dt_ok ? rpm_filter_evaluate(s->harmonics, in) : (s->harmonics ? RPM_FILTER_ERPM_UNAVAILABLE : RPM_FILTER_OFF);
    const unsigned allowed = rpm_filter_allowed_harmonics(fs);
    b->harmonics_active = b->reason == RPM_FILTER_OK ? (s->harmonics < allowed ? s->harmonics : allowed) : 0u;
    const float limit = FILTER_NOTCH_NYQUIST_MARGIN * 0.5f * fs;
    for (unsigned m = 0; m < RPM_FILTER_MOTORS; m++) {
        const float f = rpm_filter_fundamental_hz(in->erpm[m], s->poles);
        const bool track = b->reason == RPM_FILTER_OK && motor_input_valid(in, m) && f > 0.f;
        b->motor_valid[m] = track;
        if (track) b->fund_hz[m] = f > s->min_hz ? f : s->min_hz;   /* held at min_hz, no jump */
        bool start = false;
        for (unsigned h = 0; h < RPM_FILTER_MAX_HARMONICS; h++) {
            const bool want = track && h < b->harmonics_active && (float)(h + 1u) * b->fund_hz[m] < limit;
            if (want && !b->want[m][h]) {
                start = true;
                if (b->weight[m][h] <= 0.f) b->prime[m][h] = true;  /* from bypass: no step transient */
            }
            if (!want) b->prime[m][h] = false;
            b->want[m][h] = want;
        }
        if (track && (all || start || m == b->rr)) motor_coeffs(b, m);
    }
    b->rr = (b->rr + 1u) % RPM_FILTER_MOTORS;
}

void rpm_filter_apply(rpm_filter_bank_t *b, float v[3])
{
    if (!b || !v) return;
    const float step = b->dt > 0.f && isfinite(b->dt) ? b->dt / RPM_FILTER_FADE_S : 1.f;
    for (unsigned m = 0; m < RPM_FILTER_MOTORS; m++) {
        for (unsigned h = 0; h < RPM_FILTER_MAX_HARMONICS; h++) {
            float w = b->weight[m][h];
            const bool want = b->want[m][h];
            if (!want && w <= 0.f) continue;
            w = want ? (w + step < 1.f ? w + step : 1.f) : (w - step > 0.f ? w - step : 0.f);
            b->weight[m][h] = w;
            if (w <= 0.f) continue;
            const filter_biquad_t *c = &b->coeff[m][h];
            filter_biquad_state_t *st = b->state[m][h];
            if (b->prime[m][h]) {
                for (unsigned a = 0; a < 3; a++)
                    if (isfinite(v[a])) filter_biquad_prime(c, &st[a], v[a]);
                b->prime[m][h] = false;
            }
            for (unsigned a = 0; a < 3; a++) {
                if (!isfinite(v[a])) continue;
                const float y = filter_biquad_step(c, &st[a], v[a]);
                v[a] += w * (y - v[a]);
            }
        }
    }
}

unsigned rpm_filter_running(const rpm_filter_bank_t *b)
{
    unsigned n = 0u;
    if (!b) return 0u;
    for (unsigned m = 0; m < RPM_FILTER_MOTORS; m++)
        for (unsigned h = 0; h < RPM_FILTER_MAX_HARMONICS; h++)
            if (b->weight[m][h] > 0.f || b->want[m][h]) n++;
    return n;
}
