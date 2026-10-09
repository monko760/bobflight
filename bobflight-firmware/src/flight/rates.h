/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * RC → rate setpoint. Pure curve helper is host-unit-testable.
 */
#ifndef BOBFLIGHT_RATES_H
#define BOBFLIGHT_RATES_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

#define RATES_MAX_DPS 800.f

void rates_init(void);

/**
 * Map one stick [-1,1] through Actual rates curve to deg/s.
 * Formula: C*x + max(M-C,0)*x*((1-E)*abs(x) + E*abs(x)^5)
 * Center rate, max rate (deg/s), expo [0,1].
 * Applies clamp to stick [-1,1], but NO deadband.
 * Failclosed on nonfinite inputs.
 * Center > max allowed, with effective endpoint max(center, max_rate).
 */
float rates_actual_map(float stick, float center, float max_rate, float expo);

/** Map rc[0..2] sticks to setpoint_dps[3]; rc[3] unused here. */
void rates_update(const float rc[4], float setpoint_dps[3]);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_RATES_H */
