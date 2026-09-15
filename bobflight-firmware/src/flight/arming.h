/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Arm / disarm state. Refuse arm if gyro unhealthy, failsafe, or throttle high.
 * Motors off at boot.
 */
#ifndef BOBFLIGHT_ARMING_H
#define BOBFLIGHT_ARMING_H

#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    ARM_DISARMED = 0,
    ARM_ARMED
} arm_state_t;

/** Throttle above this (0..1) refuses arm. */
#define ARMING_THROTTLE_MAX 0.05f

void arming_init(void);
arm_state_t arming_state(void);
/* True when the currently requested control mode is gyro-only (Acro).
 * Leveled modes (Angle/Horizon) still require qualified gravity. */
bool arming_rate_only(void);
bool arming_try_arm(void);   /* false if gyro / failsafe / throttle high */
void arming_disarm(void);
void arming_set_gyro_healthy(bool healthy);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_ARMING_H */
