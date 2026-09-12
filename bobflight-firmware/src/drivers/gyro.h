/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Gyro driver. SPI/EXTI from board_get(); WHOAMI from public datasheets.
 * Host SPI zeros → fail-closed (gyro_ok: no). Healthy only on WHOAMI match.
 */
#ifndef BOBFLIGHT_GYRO_H
#define BOBFLIGHT_GYRO_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

void gyro_init(void);
void gyro_begin_calibration(void);
bool gyro_calibrated(void);
const float *gyro_accel_g(void);
const float *gyro_latest_dps(void);
bool gyro_sample(float dps[3]);
bool gyro_is_healthy(void);
void gyro_filter(const float in_dps[3], float out_dps[3]);
/** "dummy" | "no-cs" | "no-spi" | "unbound" | "bf-derived" | "ok" */
const char *gyro_bind_state(void);

#if BOBFLIGHT_HOST
/** Force last sample + healthy for cascade/PID host tests. Cleared by gyro_init(). */
void gyro_host_inject_dps(const float dps[3], bool healthy);
#endif

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_GYRO_H */
