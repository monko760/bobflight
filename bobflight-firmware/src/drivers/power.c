/* SPDX-License-Identifier: Apache-2.0 */
#include "drivers/power.h"
#include "hal/hal.h"
#include "board/pins_generated.h"
#include <math.h>
#include <string.h>

static power_state_t state;
static power_config_t cfg;
static uint32_t last_sample;
static bool sampled;

void power_init(void) {
    memset(&state, 0, sizeof(state));
    cfg = (power_config_t){11.f, 0.f, 0.f, 0, 3.5f, 3.3f, 0};
    sampled = false;
    last_sample = 0;
    hal_power_adc_init(BOARD_GENERATED_VBAT_PIN, BOARD_GENERATED_CURRENT_PIN);
}
const power_state_t *power_state(void) { return &state; }
const power_config_t *power_config(void) { return &cfg; }
bool power_configure(const power_config_t *c) {
    if (!c || !isfinite(c->voltage_scale) || c->voltage_scale < 1 || c->voltage_scale > 30 ||
        !isfinite(c->current_mv_per_amp) || c->current_mv_per_amp < 0 || c->current_mv_per_amp > 1000 ||
        (c->current_mv_per_amp > 0 && c->current_mv_per_amp < 1) ||
        !isfinite(c->current_offset_mv) || c->current_offset_mv < 0 || c->current_offset_mv > 3300 ||
        c->cells > 6 || !isfinite(c->warning_cell_v) || !isfinite(c->critical_cell_v) ||
        c->critical_cell_v < 2.5f || c->warning_cell_v > 4.3f ||
        c->critical_cell_v >= c->warning_cell_v || c->capacity_mah > 50000) return false;
    cfg = *c;
    /* A scale change starts a new measurement session; do not mix units. */
    memset(&state, 0, sizeof(state)); sampled = false;
    return true;
}
void power_expire(uint32_t now) {
    if (sampled && (uint32_t)(now-last_sample) > 500u) {
        state.valid = state.current_valid = state.consumption_valid = false;
    }
}
void power_sample(uint32_t now, uint16_t v, uint16_t i) {
    const uint32_t dt = now-last_sample;
    const bool previous_present = state.present;
    const bool previous_current = state.current_valid;
    if (v >= 4095u || i > 4095u) {
        state.valid = state.current_valid = state.consumption_valid = false;
        return;
    }
    float voltage = (float)v * (3.3f/4095.f) * cfg.voltage_scale;
    state.voltage = sampled && state.valid ? state.voltage + 0.25f*(voltage-state.voltage) : voltage;
    /* Presence uses raw voltage so removing a pack cannot integrate a filter tail. */
    state.present = voltage >= 2.f;
    state.valid = true;
    state.raw_voltage = v; state.raw_current = i;
    state.current_valid = state.present && cfg.current_mv_per_amp > 0 && i < 4095u;
    state.amps = state.current_valid ? fmaxf(0.f, ((float)i*3300.f/4095.f-cfg.current_offset_mv)/cfg.current_mv_per_amp) : 0.f;
    if (!state.present || !previous_present) {
        state.consumed_mah = 0;
        state.consumption_valid = state.current_valid;
    } else if (!state.current_valid || !previous_current || dt > 500u) {
        /* Missing samples mean total consumption is incomplete until pack replacement. */
        state.consumption_valid = false;
    } else if (sampled && state.consumption_valid) {
        state.consumed_mah += state.amps*(float)dt/3600.f;
    }
    last_sample = now; sampled = true;
}
void power_poll(void) {
    uint16_t v, i;
    uint32_t now = hal_millis();
    if (hal_power_adc_poll(&v, &i)) power_sample(now, v, i);
    power_expire(now);
}
const char *power_warning(void) {
    if (!state.valid) return "unavailable";
    if (!state.present) return "no_battery";
    if (!cfg.cells) return "set_cells";
    float cell = state.voltage/(float)cfg.cells;
    if (cell > 4.45f || cell < 2.f) return "check_cells";
    if (cell <= cfg.critical_cell_v) return "critical";
    if (cell <= cfg.warning_cell_v) return "low";
    if (cfg.capacity_mah && state.consumption_valid && state.consumed_mah >= cfg.capacity_mah*0.8f) return "capacity";
    return "ok";
}
