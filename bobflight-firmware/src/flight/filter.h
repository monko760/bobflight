/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Soft first-order low-pass helpers for gyro and D-term paths.
 *
 * Formula (documented in docs/FLIGHT.md):
 *   tau   = 1 / (2 * pi * fc)
 *   alpha = dt / (tau + dt)
 *   y[n]  = y[n-1] + alpha * (x[n] - y[n-1])
 *
 * fc_hz <= 0 means filter off (passthrough: alpha = 1).
 *
 * Second-order notch (manual gyro notches, schema 8), written from the
 * bilinear-transform notch in R. Bristow-Johnson's public "Audio EQ Cookbook":
 *   w0    = 2*pi*f0/fs,  alpha = sin(w0)/(2*Q)
 *   H(z)  = (1 - 2cos(w0) z^-1 + z^-2) / ((1+alpha) - 2cos(w0) z^-1 + (1-alpha) z^-2)
 * Q comes from the centre f0 and the lower -3 dB edge fc (upper edge f0^2/fc,
 * so f0 is their geometric mean):  Q = f0*fc / (f0^2 - fc^2).
 * Runs as a transposed direct form II biquad (2 state floats per axis).
 * Clean-room; no Betaflight source.
 */
#ifndef BOBFLIGHT_FILTER_H
#define BOBFLIGHT_FILTER_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** LPF coefficient for cut-off fc_hz [Hz] and sample period dt [s]. */
float filter_lpf_alpha(float fc_hz, float dt);

/**
 * One LPF step. Updates *state in place and returns the filtered value.
 * If alpha >= 1 (off / passthrough), state becomes x and x is returned.
 */
float filter_lpf_step(float *state, float x, float alpha);

/* ---- Second-order notch (biquad) -------------------------------------- */

/** Normalised biquad coefficients (a0 == 1). */
typedef struct {
    float b0, b1, b2, a1, a2;
} filter_biquad_t;

/** Transposed direct form II state (one per axis). */
typedef struct {
    float z1, z2;
} filter_biquad_state_t;

/* Static setting domain (config.c mirrors this for CLI/persist validation). */
#define FILTER_NOTCH_CENTER_MIN_HZ 20.f
#define FILTER_NOTCH_CENTER_MAX_HZ 1000.f
/* The centre must stay below this fraction of the filter's Nyquist
 * frequency (fs/2), i.e. f0 < 0.45 * fs: 450 Hz at a 1 kHz loop, 1800 Hz at
 * 4 kHz (so any centre <= 1000 Hz), 3600 Hz at 8 kHz. */
#define FILTER_NOTCH_NYQUIST_MARGIN 0.9f

/** Q from centre and lower -3 dB edge; 0 when the pair is not a valid notch. */
float filter_notch_q(float center_hz, float cutoff_hz);

/** Highest centre (exclusive) allowed at sample rate sample_hz; 0 if invalid. */
float filter_notch_center_limit_hz(float sample_hz);

/** True when center_hz is inside the static domain with a valid cutoff. */
bool filter_notch_pair_valid(float center_hz, float cutoff_hz);

/**
 * Fill *c with the notch at center_hz / cutoff_hz for sample rate sample_hz.
 * Returns false (and leaves *c as passthrough) when the pair is invalid, the
 * centre is not below filter_notch_center_limit_hz(), or the result is not finite.
 */
bool filter_biquad_notch(filter_biquad_t *c, float center_hz, float cutoff_hz, float sample_hz);

/** Passthrough coefficients (b0 = 1, rest 0). */
void filter_biquad_passthrough(filter_biquad_t *c);

/** Set the state to the steady state of a constant input x (no step transient). */
void filter_biquad_prime(const filter_biquad_t *c, filter_biquad_state_t *s, float x);

/** One sample: 5 multiplies, 4 adds, 2 state floats. */
static inline float filter_biquad_step(const filter_biquad_t *c, filter_biquad_state_t *s, float x)
{
    const float y = c->b0 * x + s->z1;
    s->z1 = c->b1 * x - c->a1 * y + s->z2;
    s->z2 = c->b2 * x - c->a2 * y;
    return y;
}

/* ---- Gyro notch bank (2 notches x 3 axes) ------------------------------ */

#define FILTER_NOTCH_COUNT 2u

/* Runtime state of one configured notch, reported by the `filters` CLI:
 * off           centre 0 (disabled by setting)
 * ok            active
 * above-nyquist valid setting, but centre >= 0.45 * the actual filter rate
 *               (e.g. after a loop-rate change); disabled at runtime only
 * invalid       setting or sample period unusable; disabled at runtime only */
typedef enum {
    FILTER_NOTCH_OFF = 0,
    FILTER_NOTCH_OK,
    FILTER_NOTCH_ABOVE_NYQUIST,
    FILTER_NOTCH_INVALID
} filter_notch_reason_t;

const char *filter_notch_reason_name(filter_notch_reason_t r);

/** Pure decision used by the bank (and nothing else): what a setting does at dt. */
filter_notch_reason_t filter_notch_evaluate(float center_hz, float cutoff_hz, float dt);

typedef struct {
    float center_hz[FILTER_NOTCH_COUNT], cutoff_hz[FILTER_NOTCH_COUNT], dt;
    bool configured;
    filter_notch_reason_t reason[FILTER_NOTCH_COUNT];
    filter_biquad_t coeff[FILTER_NOTCH_COUNT];
    filter_biquad_state_t state[FILTER_NOTCH_COUNT][3];
    bool prime[FILTER_NOTCH_COUNT];
    uint32_t recomputes; /* coefficient recomputations (diagnostics/tests) */
} filter_notch_bank_t;

void filter_notch_bank_init(filter_notch_bank_t *b);

/**
 * Recompute coefficients only when a setting or dt changed (a few compares per
 * call otherwise). Never modifies the settings. Returns true if recomputed.
 */
bool filter_notch_bank_update(filter_notch_bank_t *b, const float center_hz[FILTER_NOTCH_COUNT],
                              const float cutoff_hz[FILTER_NOTCH_COUNT], float dt);

/** Apply every active notch to the three axes, in place. */
void filter_notch_bank_apply(filter_notch_bank_t *b, float v[3]);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_FILTER_H */
