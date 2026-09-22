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
#define DEF_MIN_THR  0.05f
#define DEF_AIRMODE  0
#define DEF_GYRO_LPF 320.f
#define DEF_DTERM_LPF 53.f

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
    .min_throttle = DEF_MIN_THR,
    .airmode = DEF_AIRMODE,
    .gyro_lpf_hz = DEF_GYRO_LPF,
    .dterm_lpf_hz = DEF_DTERM_LPF,
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
    g_cfg.min_throttle = DEF_MIN_THR;
    g_cfg.airmode = DEF_AIRMODE;
    g_cfg.gyro_lpf_hz = DEF_GYRO_LPF;
    g_cfg.dterm_lpf_hz = DEF_DTERM_LPF;
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
    if (strcmp(key, "min_throttle") == 0) {
        return &g_cfg.min_throttle;
    }
    if (strcmp(key, "gyro_lpf_hz") == 0) {
        return &g_cfg.gyro_lpf_hz;
    }
    if (strcmp(key, "dterm_lpf_hz") == 0) {
        return &g_cfg.dterm_lpf_hz;
    }
    return NULL;
}

bool config_get_key(const char *key, float *out)
{
    if (!key || !out) {
        return false;
    }
    if (strcmp(key, "airmode") == 0) {
        *out = (float)g_cfg.airmode;
        return true;
    }
    float *slot = slot_for(key);
    if (!slot) {
        return false;
    }
    *out = *slot;
    return true;
}

bool config_set_key(const char *key, float value)
{
    if (!key || !isfinite(value)) {
        return false;
    }
    if (strcmp(key, "airmode") == 0) {
        if (value != 0.f && value != 1.f) {
            return false;
        }
        g_cfg.airmode = (uint8_t)value;
        return true;
    }
    float *slot = slot_for(key);
    if (!slot) {
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
    } else if (strcmp(key, "min_throttle") == 0) {
        if (value < 0.f || value > 0.2f) {
            return false;
        }
    } else if (strcmp(key, "gyro_lpf_hz") == 0 || strcmp(key, "dterm_lpf_hz") == 0) {
        /* 0 = off; else 10..1000 Hz (schema5 Lead lock) */
        if (value != 0.f && (value < 10.f || value > 1000.f)) {
            return false;
        }
    } else if (value < 0.f || value > 10.f) {
        return false;
    }
    *slot = value;
    return true;
}
