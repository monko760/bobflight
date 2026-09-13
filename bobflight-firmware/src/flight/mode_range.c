/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "flight/mode_range.h"
#include "flight/arming.h"
#include "drivers/rx.h"
#include "sched/tasks.h"

#include <math.h>
#include <string.h>

static mode_config_t g_modes[MODE_COUNT];

void mode_range_reset(void)
{
    /* Defaults: ARM on AUX1 high (1751..2100); ANGLE on AUX2 full range (900..2100) */
    g_modes[MODE_ARM].enabled = true;
    g_modes[MODE_ARM].aux_channel = 1;
    g_modes[MODE_ARM].min_us = 1751;
    g_modes[MODE_ARM].max_us = 2100;

    g_modes[MODE_ANGLE].enabled = true;
    g_modes[MODE_ANGLE].aux_channel = 2;
    g_modes[MODE_ANGLE].min_us = 900;
    g_modes[MODE_ANGLE].max_us = 2100;

}

void mode_range_init(void)
{
    mode_range_reset();
}

const mode_config_t *mode_range_get(mode_id_t mode)
{
    if ((int)mode < 0 || mode >= MODE_COUNT) {
        return NULL;
    }
    return &g_modes[mode];
}

bool mode_range_set(mode_id_t mode, bool enabled, uint8_t aux, uint16_t min_us, uint16_t max_us)
{
    if ((int)mode < 0 || mode >= MODE_COUNT) {
        return false;
    }
    if (arming_state() == ARM_ARMED || bench_motor_active()) {
        return false;
    }
    if (aux < 1 || aux > 12) {
        return false;
    }
    if (min_us < 900 || min_us > 2100 || max_us < 900 || max_us > 2100) {
        return false;
    }
    if (min_us >= max_us) {
        return false;
    }

    g_modes[mode].enabled = enabled;
    g_modes[mode].aux_channel = aux;
    g_modes[mode].min_us = min_us;
    g_modes[mode].max_us = max_us;

    /* Preview configuration never changes the control-loop arming latch. */
    return true;
}

bool mode_range_is_active(mode_id_t mode)
{
    if ((int)mode < 0 || mode >= MODE_COUNT) {
        return false;
    }
    if (mode == MODE_ARM && bench_motor_active()) {
        return false;
    }
    const mode_config_t *cfg = &g_modes[mode];
    if (!cfg->enabled) {
        return false;
    }
    if (!rx_frame_fresh()) {
        return false;
    }
    const float *rc = rx_channels();
    if (!rc) {
        return false;
    }

    if (cfg->aux_channel < 1 || cfg->aux_channel > 12) {
        return false;
    }
    unsigned idx = 3u + cfg->aux_channel;
    if (idx >= 16u) {
        return false;
    }
    float val = rc[idx];
    if (!isfinite(val) || val < -1.0f || val > 1.0f) {
        return false;
    }

    uint16_t us = (uint16_t)lroundf(1500.0f + val * 500.0f);
    return (us >= cfg->min_us && us <= cfg->max_us);
}
