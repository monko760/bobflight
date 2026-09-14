/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef BOBFLIGHT_MODE_RANGE_H
#define BOBFLIGHT_MODE_RANGE_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    MODE_ARM = 0,
    MODE_ANGLE = 1,
    MODE_ACRO = 2,
    MODE_HORIZON = 3,
    MODE_COUNT = 4
} mode_id_t;

typedef struct {
    bool enabled;
    uint8_t aux_channel; /* 1..12 */
    uint16_t min_us;    /* 900..2100 */
    uint16_t max_us;    /* 900..2100 */
} mode_config_t;

void mode_range_init(void);
void mode_range_reset(void);
const mode_config_t *mode_range_get(mode_id_t mode);
bool mode_range_set(mode_id_t mode, bool enabled, uint8_t aux, uint16_t min_us, uint16_t max_us);
bool mode_range_is_active(mode_id_t mode);
/* Returns input validity separately from the active range match. */
bool mode_range_arm_input(bool *active);
/* Invalidates cached switch edges after ARM edits/reset, including A->B->A. */
uint32_t mode_range_arm_revision(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_MODE_RANGE_H */
