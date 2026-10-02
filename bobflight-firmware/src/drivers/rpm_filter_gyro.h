/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_RPM_FILTER_GYRO_H
#define BOBFLIGHT_RPM_FILTER_GYRO_H
/* RPM notch filter runtime: owns the notch bank, reads the schema 9 settings
 * and bidirectional DShot eRPM (drivers/dshot_telem.h), and runs as the gyro
 * post-filter (after the LPF and the manual notches). Kept out of gyro.c so
 * gyro-only host targets do not link the DShot telemetry. */
#include <stdbool.h>
#include "flight/rpm_filter.h"
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    rpm_filter_reason_t reason;
    unsigned harmonics, harmonics_active;
    bool motor_valid[RPM_FILTER_MOTORS];   /* tracked (reason ok and valid eRPM) */
    float motor_hz[RPM_FILTER_MOTORS];     /* held fundamental, Hz (only when tracked) */
} rpm_filter_status_t;
/** Register rpm_filter_gyro_process() as the gyro post-filter (app init). */
void rpm_filter_gyro_install(void);
/** Gyro post-filter: update from the latest telemetry, then apply (in place). */
void rpm_filter_gyro_process(float v[3], float dt);
/** Refresh the state at filter period dt (no samples filtered) and report it. */
void rpm_filter_gyro_status(rpm_filter_status_t *st, float dt);
#ifdef __cplusplus
}
#endif
#endif
