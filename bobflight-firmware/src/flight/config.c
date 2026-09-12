/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "flight/config.h"

#include <string.h>
#include <math.h>

#define DEF_RATE_MAX 800.f
#define DEF_EXPO     0.30f
#define DEF_KP       0.002f
#define DEF_KI       0.001f
#define DEF_KD       0.00005f

static bf_config_t g_cfg = {
    .rate_max_roll = DEF_RATE_MAX,
    .rate_max_pitch = DEF_RATE_MAX,
    .rate_max_yaw = DEF_RATE_MAX,
    .rate_expo = DEF_EXPO,
    .pid_roll_p = DEF_KP,
    .pid_roll_i = DEF_KI,
    .pid_roll_d = DEF_KD,
    .pid_pitch_p = DEF_KP,
    .pid_pitch_i = DEF_KI,
    .pid_pitch_d = DEF_KD,
    .pid_yaw_p = DEF_KP,
    .pid_yaw_i = DEF_KI,
};

void config_defaults(void)
{
    g_cfg.rate_max_roll = DEF_RATE_MAX;
    g_cfg.rate_max_pitch = DEF_RATE_MAX;
    g_cfg.rate_max_yaw = DEF_RATE_MAX;
    g_cfg.rate_expo = DEF_EXPO;
    g_cfg.pid_roll_p = DEF_KP;
    g_cfg.pid_roll_i = DEF_KI;
    g_cfg.pid_roll_d = DEF_KD;
    g_cfg.pid_pitch_p = DEF_KP;
    g_cfg.pid_pitch_i = DEF_KI;
    g_cfg.pid_pitch_d = DEF_KD;
    g_cfg.pid_yaw_p = DEF_KP;
    g_cfg.pid_yaw_i = DEF_KI;
}

void config_init(void)
{
    config_defaults();
}

const bf_config_t *config_get(void)
{
    return &g_cfg;
}

const bf_config_t *config_blob(void)
{
    return &g_cfg;
}

void config_load_blob(const bf_config_t *src)
{
    if (src) {
        g_cfg = *src;
    }
}

static float *slot_for(const char *key)
{
    if (!key) {
        return NULL;
    }
    if (strcmp(key, "rate_max_roll") == 0) {
        return &g_cfg.rate_max_roll;
    }
    if (strcmp(key, "rate_max_pitch") == 0) {
        return &g_cfg.rate_max_pitch;
    }
    if (strcmp(key, "rate_max_yaw") == 0) {
        return &g_cfg.rate_max_yaw;
    }
    if (strcmp(key, "rate_expo") == 0) {
        return &g_cfg.rate_expo;
    }
    if (strcmp(key, "pid_roll_p") == 0) {
        return &g_cfg.pid_roll_p;
    }
    if (strcmp(key, "pid_roll_i") == 0) {
        return &g_cfg.pid_roll_i;
    }
    if (strcmp(key, "pid_roll_d") == 0) {
        return &g_cfg.pid_roll_d;
    }
    if (strcmp(key, "pid_pitch_p") == 0) {
        return &g_cfg.pid_pitch_p;
    }
    if (strcmp(key, "pid_pitch_i") == 0) {
        return &g_cfg.pid_pitch_i;
    }
    if (strcmp(key, "pid_pitch_d") == 0) {
        return &g_cfg.pid_pitch_d;
    }
    if (strcmp(key, "pid_yaw_p") == 0) {
        return &g_cfg.pid_yaw_p;
    }
    if (strcmp(key, "pid_yaw_i") == 0) {
        return &g_cfg.pid_yaw_i;
    }
    return NULL;
}

bool config_get_key(const char *key, float *out)
{
    float *slot = slot_for(key);
    if (!slot || !out) {
        return false;
    }
    *out = *slot;
    return true;
}

bool config_set_key(const char *key, float value)
{
    float *slot = slot_for(key);
    if (!slot) {
        return false;
    }
    if (!isfinite(value)) {
        return false;
    }
    if (strncmp(key, "rate_max_", 9) == 0) {
        if (value < 10.f || value > 2000.f) {
            return false;
        }
    } else if (strcmp(key, "rate_expo") == 0) {
        if (value < 0.f || value > 1.f) {
            return false;
        }
    } else if (value < 0.f || value > 10.f) {
        return false;
    }
    *slot = value;
    return true;
}
