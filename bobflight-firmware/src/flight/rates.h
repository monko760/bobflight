/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * RC → rate setpoint. Pure curve helper is host-unit-testable.
 */
#ifndef BOBFLIGHT_RATES_H
#define BOBFLIGHT_RATES_H

#ifdef __cplusplus
extern "C" {
#endif

#define RATES_MAX_DPS 800.f

void rates_init(void);

/**
 * Map one stick [-1,1] through expo curve to deg/s.
 * Full deflection → ±max_rate_dps. Pure math (no drivers).
 */
float rates_curve_map(float stick, float max_rate_dps);

/** Map rc[0..2] sticks to setpoint_dps[3]; rc[3] unused here. */
void rates_update(const float rc[4], float setpoint_dps[3]);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_RATES_H */
