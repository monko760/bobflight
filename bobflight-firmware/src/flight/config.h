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
    float pid_yaw_d;
    float min_throttle; /* armed idle floor 0..0.2; default 0.05 (BF-like suggestion) */
    uint8_t airmode;    /* 0=off (bench-safe), 1=keep I integrating at idle */
    float gyro_lpf_hz;  /* soft gyro LPF; 0=off, else 10..1000; default 320 */
    float dterm_lpf_hz; /* soft D-term LPF; 0=off, else 10..1000; default 53 */
    /* Manual gyro notches (schema 8). Centre 0 = off, else 20..1000 Hz with
     * 0 < cutoff < centre (cutoff = lower -3 dB edge). Defaults 0/0. The
     * sample-rate (Nyquist) limit is not a stored-setting property: the CLI
     * refuses it at `set`, and the filter disables an out-of-range notch at
     * runtime (reported by `filters`) without touching these values. */
    float gyro_notch1_hz;
    float gyro_notch1_cutoff_hz;
    float gyro_notch2_hz;
    float gyro_notch2_cutoff_hz;
    /* RPM notch filter (schema 9), whole numbers stored as floats:
     * rpm_filter_harmonics 0..3 (0 = off, default 0), rpm_filter_min_hz
     * 50..200 (default 100), rpm_filter_q_x100 100..1000 (Q x 100, default 500),
     * motor_poles even 4..36 (default 14). See docs/RPM-FILTER.md. */
    float rpm_filter_harmonics;
    float rpm_filter_min_hz;
    float rpm_filter_q_x100;
    float motor_poles;
} bf_config_t;

void config_init(void);
void config_defaults(void);
const bf_config_t *config_get(void);
bool config_get_key(const char *key, float *out);
bool config_set_key(const char *key, float value);
const bf_config_t *config_blob(void);
/** Static notch pair rule: centre 0 (cutoff 0..<1000), or 20..1000 with 0 < cutoff < centre. */
bool config_gyro_notch_pair_valid(float center_hz, float cutoff_hz);
/** Set notch idx (1 or 2) centre+cutoff together (persist restore); false leaves both unchanged. */
bool config_set_gyro_notch(unsigned idx, float center_hz, float cutoff_hz);
/** Schema 9 RPM filter keys: true for rpm_filter_harmonics/min_hz/q_x100 and motor_poles. */
bool config_is_rpm_key(const char *key);
/** Static domain of one schema 9 RPM key (whole number in range; motor_poles even). */
bool config_rpm_value_valid(const char *key, float value);
void config_load_blob(const bf_config_t *src);

/* Motor direction (schema 10, CLI `motor_direction`): tells the mixer which way
 * the props spin. It does NOT change the spin direction in the ESC.
 *   props-out (default) = the QUADX yaw signs in flight/mixer.c unchanged
 *   props-in            = the yaw term negated on all four motors
 * Kept outside bf_config_t (a token, not a float key). See docs/MOTOR-DIRECTION.md. */
typedef enum { MOTOR_DIRECTION_PROPS_OUT = 0, MOTOR_DIRECTION_PROPS_IN = 1 } motor_direction_t;
motor_direction_t config_motor_direction(void);
/** Valid value: stored (applies at the next mixer call) and true; otherwise unchanged and false. */
bool config_set_motor_direction(motor_direction_t direction);
/** "props-out" | "props-in" (NULL for an invalid value). */
const char *config_motor_direction_name(motor_direction_t direction);
/** Exact token "props-out" | "props-in" (case-sensitive, no spaces). */
bool config_motor_direction_parse(const char *text, motor_direction_t *out);

#ifdef __cplusplus
}
#endif

#endif
