/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * First-order LPF: alpha = dt/(tau+dt), tau = 1/(2*pi*fc).
 * Biquad notch: RBJ cookbook bilinear notch (see filter.h), clean-room.
 */
#include "flight/filter.h"

#include <math.h>
#include <string.h>

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

/* ---- Second-order notch -------------------------------------------------- */

bool filter_notch_pair_valid(float center_hz, float cutoff_hz)
{
    return isfinite(center_hz) && isfinite(cutoff_hz) &&
           center_hz >= FILTER_NOTCH_CENTER_MIN_HZ && center_hz <= FILTER_NOTCH_CENTER_MAX_HZ &&
           cutoff_hz > 0.f && cutoff_hz < center_hz;
}

float filter_notch_q(float center_hz, float cutoff_hz)
{
    if (!filter_notch_pair_valid(center_hz, cutoff_hz)) {
        return 0.f;
    }
    /* Lower edge fc, upper edge f0^2/fc: bandwidth (f0^2 - fc^2)/fc. */
    return center_hz * cutoff_hz / (center_hz * center_hz - cutoff_hz * cutoff_hz);
}

float filter_notch_center_limit_hz(float sample_hz)
{
    if (!isfinite(sample_hz) || !(sample_hz > 0.f)) {
        return 0.f;
    }
    return FILTER_NOTCH_NYQUIST_MARGIN * 0.5f * sample_hz;
}

void filter_biquad_passthrough(filter_biquad_t *c)
{
    if (c) {
        c->b0 = 1.f;
        c->b1 = c->b2 = c->a1 = c->a2 = 0.f;
    }
}

bool filter_biquad_notch(filter_biquad_t *c, float center_hz, float cutoff_hz, float sample_hz)
{
    if (!c) {
        return false;
    }
    filter_biquad_passthrough(c);
    const float q = filter_notch_q(center_hz, cutoff_hz);
    if (!(q > 0.f) || !(center_hz < filter_notch_center_limit_hz(sample_hz))) {
        return false;
    }
    const float w0 = 2.f * (float)M_PI * center_hz / sample_hz;
    const float cw = cosf(w0);
    const float alpha = sinf(w0) / (2.f * q);
    const float a0 = 1.f + alpha;
    const float n = 1.f / a0;
    filter_biquad_t t;
    t.b0 = n;
    t.b1 = -2.f * cw * n;
    t.b2 = n;
    t.a1 = -2.f * cw * n;
    t.a2 = (1.f - alpha) * n;
    if (!isfinite(t.b0) || !isfinite(t.b1) || !isfinite(t.a1) || !isfinite(t.a2)) {
        return false;
    }
    *c = t;
    return true;
}

void filter_biquad_prime(const filter_biquad_t *c, filter_biquad_state_t *s, float x)
{
    if (!c || !s) {
        return;
    }
    if (!isfinite(x)) {
        x = 0.f;
    }
    /* y == dc_gain * x at rest; for the notch dc_gain is exactly 1 in theory. */
    const float den = 1.f + c->a1 + c->a2;
    const float y = den != 0.f ? x * (c->b0 + c->b1 + c->b2) / den : x;
    s->z2 = c->b2 * x - c->a2 * y;
    s->z1 = c->b1 * x - c->a1 * y + s->z2;
}

/* ---- Gyro notch bank ----------------------------------------------------- */

const char *filter_notch_reason_name(filter_notch_reason_t r)
{
    switch (r) {
    case FILTER_NOTCH_OFF: return "off";
    case FILTER_NOTCH_OK: return "ok";
    case FILTER_NOTCH_ABOVE_NYQUIST: return "above-nyquist";
    case FILTER_NOTCH_INVALID:
    default: return "invalid";
    }
}

filter_notch_reason_t filter_notch_evaluate(float center_hz, float cutoff_hz, float dt)
{
    if (center_hz == 0.f) {
        return FILTER_NOTCH_OFF;
    }
    if (!filter_notch_pair_valid(center_hz, cutoff_hz) || !isfinite(dt) || !(dt > 0.f)) {
        return FILTER_NOTCH_INVALID;
    }
    if (!(center_hz < filter_notch_center_limit_hz(1.f / dt))) {
        return FILTER_NOTCH_ABOVE_NYQUIST;
    }
    filter_biquad_t c;
    return filter_biquad_notch(&c, center_hz, cutoff_hz, 1.f / dt) ? FILTER_NOTCH_OK : FILTER_NOTCH_INVALID;
}

void filter_notch_bank_init(filter_notch_bank_t *b)
{
    if (!b) {
        return;
    }
    memset(b, 0, sizeof(*b));
    for (unsigned i = 0; i < FILTER_NOTCH_COUNT; i++) {
        filter_biquad_passthrough(&b->coeff[i]);
    }
}

bool filter_notch_bank_update(filter_notch_bank_t *b, const float center_hz[FILTER_NOTCH_COUNT],
                              const float cutoff_hz[FILTER_NOTCH_COUNT], float dt)
{
    if (!b || !center_hz || !cutoff_hz) {
        return false;
    }
    if (b->configured && b->dt == dt) {
        bool same = true;
        for (unsigned i = 0; i < FILTER_NOTCH_COUNT; i++) {
            same = same && b->center_hz[i] == center_hz[i] && b->cutoff_hz[i] == cutoff_hz[i];
        }
        if (same) {
            return false;
        }
    }
    for (unsigned i = 0; i < FILTER_NOTCH_COUNT; i++) {
        b->center_hz[i] = center_hz[i];
        b->cutoff_hz[i] = cutoff_hz[i];
        b->reason[i] = filter_notch_evaluate(center_hz[i], cutoff_hz[i], dt);
        if (b->reason[i] == FILTER_NOTCH_OK && isfinite(dt) && dt > 0.f &&
            filter_biquad_notch(&b->coeff[i], center_hz[i], cutoff_hz[i], 1.f / dt)) {
            /* New coefficients: restart from the steady state of the next sample
             * (no step transient). A notch that stays active keeps no stale
             * state from different coefficients either. */
            b->prime[i] = true;
        } else {
            if (b->reason[i] == FILTER_NOTCH_OK) {
                b->reason[i] = FILTER_NOTCH_INVALID;
            }
            filter_biquad_passthrough(&b->coeff[i]);
            b->prime[i] = false;
        }
    }
    b->dt = dt;
    b->configured = true;
    b->recomputes++;
    return true;
}

void filter_notch_bank_apply(filter_notch_bank_t *b, float v[3])
{
    if (!b || !v) {
        return;
    }
    for (unsigned i = 0; i < FILTER_NOTCH_COUNT; i++) {
        if (b->reason[i] != FILTER_NOTCH_OK) {
            continue;
        }
        const filter_biquad_t *c = &b->coeff[i];
        if (b->prime[i]) {
            for (unsigned a = 0; a < 3; a++) {
                filter_biquad_prime(c, &b->state[i][a], v[a]);
            }
            b->prime[i] = false;
        }
        for (unsigned a = 0; a < 3; a++) {
            if (isfinite(v[a])) {
                v[a] = filter_biquad_step(c, &b->state[i][a], v[a]);
            }
        }
    }
}

void filter_gyro_chain_step(float lpf_state[3], filter_notch_bank_t *notch, float lpf_hz,
                            float dt, const float in[3], float out[3])
{
    if (!lpf_state || !in || !out) {
        return;
    }
    const float alpha = filter_lpf_alpha(lpf_hz, dt);
    for (unsigned i = 0; i < 3; i++) {
        out[i] = filter_lpf_step(&lpf_state[i], in[i], alpha);
    }
    if (notch) {
        filter_notch_bank_apply(notch, out);
    }
}
