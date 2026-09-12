/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_SENSOR_CALIBRATION_H
#define BOBFLIGHT_SENSOR_CALIBRATION_H
#include <stdbool.h>
#include "drivers/calibration_policy.h"
#include <stdint.h>
typedef enum {SC_IDLE,SC_GYRO,SC_ACCEL_WAIT,SC_ACCEL_COLLECT,SC_COMPLETE,SC_ERROR} sc_mode_t;
typedef struct {
    float gyro_bias[3],accel_bias[3],accel_scale[3];
    bool gyro_valid,accel_valid;
    bool candidate_valid;
    float candidate_bias[3],candidate_scale[3];
    char apply_detail[256];
    sc_mode_t mode;
    const char *reason;
    unsigned samples,faces;
    int face;
    uint32_t phase_started,session_started,last_ms,window_started;
    bool have_last;
    float mean[6],m2[6],face_mean[6][3];
} sensor_calibration_t;
void sc_init(sensor_calibration_t *c);
void sc_begin_gyro(sensor_calibration_t *c,uint32_t now);
void sc_begin_accel(sensor_calibration_t *c,uint32_t now);
bool sc_capture_face(sensor_calibration_t *c,unsigned face,uint32_t now);
bool sc_apply_accel(sensor_calibration_t *c);
void sc_cancel(sensor_calibration_t *c,const char *reason);
void sc_tick(sensor_calibration_t *c,uint32_t now);
void sc_feed(sensor_calibration_t *c,const float gyro[3],const float raw_acc[3],uint32_t now);
void sc_correct_accel(const sensor_calibration_t *c,const float in[3],float out[3]);
const char *sc_state_name(const sensor_calibration_t *c);
unsigned sc_required(const sensor_calibration_t *c);
#endif
