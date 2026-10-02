/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Gyro driver. SPI/EXTI from board_get(); WHOAMI from public datasheets.
 * Host SPI zeros → fail-closed (gyro_ok: no). Healthy only on WHOAMI match.
 */
#ifndef BOBFLIGHT_GYRO_H
#define BOBFLIGHT_GYRO_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    uint32_t sample_seq, sample_ms;
    bool config_ok;
    uint8_t gyro_config, accel_config;
    const char *chip;
    float raw_acc_g[3];
    /* Configured sensor output data rate (0 = unknown) and the SPI clock used
     * for sensor/interrupt register reads (0 = left at the config clock). */
    uint32_t odr_hz, spi_read_hz;
} gyro_diagnostics_t;

typedef struct {
    const char *state, *reason, *apply_detail;
    bool candidate_valid;
    float candidate_bias[3],candidate_scale[3],face_mean[6][3];
    unsigned samples, required, faces;
    int face;
    bool accel_valid;
    float gyro_bias[3], accel_bias[3], accel_scale[3];
} gyro_calibration_info_t;

uint32_t gyro_accel_calibration_binding(void);
bool gyro_accel_restore_valid(const float bias[3],const float scale[3],uint32_t binding);
void gyro_restore_accel_calibration(const float bias[3],const float scale[3],bool valid);
const gyro_diagnostics_t *gyro_diagnostics(void);
void gyro_calibration_info(gyro_calibration_info_t *info);
/* Parent CLI enforces disarmed, no motor output, fresh supported sensor and USB.
 * These are nonblocking sessions; Apply is RAM, explicit save persists validated accel on supported boards. */
bool gyro_start_manual_calibration(void);
bool gyro_start_accel_calibration(void);
bool gyro_capture_accel_face(unsigned face);
bool gyro_apply_accel_calibration(void);
void gyro_cancel_manual_calibration(void);
bool gyro_manual_calibration_active(void);
void gyro_calibration_tick(void);
/** Sensor-query lease: manual sessions expire after two seconds without UI. */
void gyro_calibration_touch(void);

void gyro_init(void);
/* Apply the loop_rate_hz output rate (MPU6000 on the 8 kHz board only). */
bool gyro_select_output_rate(bool fast);
void gyro_begin_calibration(void);
bool gyro_calibrated(void);
/** Stricter pre-arm readiness: gyro bias alone does not validate gravity. */
bool gyro_flight_ready(void);
/* Gyro-only readiness (rate/Acro control); no accelerometer requirement. */
bool gyro_rate_ready(void);
const float *gyro_accel_g(void);
const float *gyro_latest_dps(void);
bool gyro_sample(float dps[3]);
bool gyro_is_healthy(void);
void gyro_filter(const float in_dps[3], float out_dps[3]);
/** Sample period for the soft gyro LPF + notches (seconds); set on every
 * gyro sample from the scheduler's 1 / gyro_hz (safety S1). */
void gyro_filter_set_dt(float dt);
/** Actual gyro-filter sample rate (1 / filter dt = gyro rate), Hz. */
float gyro_filter_sample_hz(void);
/** Filter sample period in seconds (the exact dt the filters run with). */
float gyro_filter_dt(void);
/** Runtime state of manual notch idx (1|2): active and reason token
 * ("off" | "ok" | "above-nyquist" | "invalid"). False for a bad idx. */
bool gyro_notch_status(unsigned idx, bool *active, const char **reason);
/** Notch coefficient recomputations since boot (diagnostics/tests). */
uint32_t gyro_notch_recomputes(void);
/* Post-filter applied in place after the manual notches (target builds; the
 * host gyro path stays a bit-exact passthrough). dt = filter period [s]. */
typedef void (*gyro_post_filter_fn)(float v[3], float dt);
void gyro_set_post_filter(gyro_post_filter_fn fn);
/** "dummy" | "no-cs" | "no-spi" | "unbound" | "bf-derived" | "ok" */
const char *gyro_bind_state(void);

#if BOBFLIGHT_HOST
/** Force last sample + healthy for cascade/PID host tests. Cleared by gyro_init(). */
void gyro_host_inject_dps(const float dps[3], bool healthy);
#endif

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_GYRO_H */
