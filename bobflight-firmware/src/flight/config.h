/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Runtime rates/PID config for CLI get/set/save/defaults.
 */
#ifndef BOBFLIGHT_CONFIG_H
#define BOBFLIGHT_CONFIG_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    float rate_max_roll;
    float rate_max_pitch;
    float rate_max_yaw;
    float rate_expo;
    float pid_roll_p;
    float pid_roll_i;
    float pid_roll_d;
    float pid_pitch_p;
    float pid_pitch_i;
    float pid_pitch_d;
    float pid_yaw_p;
    float pid_yaw_i;
    float min_throttle; /* armed idle floor 0..0.2; default 0.05 (BF-like suggestion) */
    uint8_t airmode;    /* 0=off (bench-safe), 1=keep I integrating at idle */
} bf_config_t;

void config_init(void);
void config_defaults(void);
const bf_config_t *config_get(void);
bool config_get_key(const char *key, float *out);
bool config_set_key(const char *key, float value);
const bf_config_t *config_blob(void);
void config_load_blob(const bf_config_t *src);

#ifdef __cplusplus
}
#endif

#endif
