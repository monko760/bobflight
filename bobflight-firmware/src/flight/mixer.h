/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * QUADX mixer — motor[4] in [0,1] idle..full.
 */
#ifndef BOBFLIGHT_MIXER_H
#define BOBFLIGHT_MIXER_H

#include <stdint.h>
#include "flight/pid.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MIXER_MOTOR_COUNT 4

void mixer_init(void);
/** Fill motor[4] in [0,1]. QUADX; clamps each channel. */
void mixer_update(const pid_axis_out_t *pid, float throttle, float motor_out[MIXER_MOTOR_COUNT]);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_MIXER_H */
