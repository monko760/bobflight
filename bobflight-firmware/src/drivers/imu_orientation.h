/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_IMU_ORIENTATION_H
#define BOBFLIGHT_IMU_ORIENTATION_H
#include <stdbool.h>
#include <string.h>
/* Sensor-to-body Z quarter turns. CW270 preserves historical (-Y, X, Z).
 * CW180_DEG_FLIP is the proper rotation diag(1,-1,-1), not a mirror. */
typedef enum { IMU_CW0, IMU_CW90, IMU_CW180, IMU_CW270, IMU_CW180_FLIP } imu_orientation_t;
static inline bool imu_orientation_parse(const char *name, imu_orientation_t *out) {
    if (!name || !out) return false;
    if (!strcmp(name,"CW0_DEG")) *out=IMU_CW0;
    else if (!strcmp(name,"CW90_DEG")) *out=IMU_CW90;
    else if (!strcmp(name,"CW180_DEG")) *out=IMU_CW180;
    else if (!strcmp(name,"CW270_DEG")) *out=IMU_CW270;
    else if (!strcmp(name,"CW180_DEG_FLIP")) *out=IMU_CW180_FLIP;
    else return false;
    return true;
}
/* Bounded swaps/sign changes only, no strings or trigonometry in the sample path. */
static inline bool imu_orientation_apply(imu_orientation_t orientation, float v[3]) {
    if (!v) return false;
    const float x=v[0], y=v[1];
    switch (orientation) {
    case IMU_CW0: return true;
    case IMU_CW90: v[0]=y; v[1]=-x; return true;
    case IMU_CW180: v[0]=-x; v[1]=-y; return true;
    case IMU_CW180_FLIP: v[1]=-y; v[2]=-v[2]; return true;
    case IMU_CW270: v[0]=-y; v[1]=x; return true;
    default: return false;
    }
}
#endif
