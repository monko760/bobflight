/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_POWER_H
#define BOBFLIGHT_POWER_H
#include <stdbool.h>
#include <stdint.h>
typedef struct {
    float voltage_scale, current_mv_per_amp, current_offset_mv;
    unsigned cells;
    float warning_cell_v, critical_cell_v;
    unsigned capacity_mah;
} power_config_t;
typedef struct {
    bool valid, present, current_valid, consumption_valid;
    float voltage, amps, consumed_mah;
    uint16_t raw_voltage, raw_current;
} power_state_t;
void power_init(void);
void power_poll(void);
/* Also used by deterministic host tests. Time is monotonic modulo uint32_t. */
void power_sample(uint32_t now, uint16_t voltage, uint16_t current);
void power_expire(uint32_t now);
const power_state_t *power_state(void);
const power_config_t *power_config(void);
bool power_config_valid(const power_config_t *cfg);
bool power_configure(const power_config_t *cfg);
const char *power_warning(void);
#endif
