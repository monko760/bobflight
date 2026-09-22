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
 * Clean-room; no Betaflight source.
 */
#ifndef BOBFLIGHT_FILTER_H
#define BOBFLIGHT_FILTER_H

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

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_FILTER_H */
