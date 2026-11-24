/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BF_ATTITUDE_H
#define BF_ATTITUDE_H
#include <stdbool.h>
/* Estimator trust state (N1). Only ATTITUDE_VALID makes attitude_ready() true.
 * UNINITIALIZED: never seeded from gravity, or reset by a rejected gyro/time sample.
 * ACCEL_INVALID: non-finite accelerometer data; gyro propagation continues.
 * GRAVITY_TIMEOUT: no in-window gravity reference for ATTITUDE_GRAVITY_TIMEOUT_S.
 * RECOVERING: gravity reference is back; converging before trust is restored. */
typedef enum {
    ATTITUDE_UNINITIALIZED = 0,
    ATTITUDE_VALID = 1,
    ATTITUDE_ACCEL_INVALID = 2,
    ATTITUDE_GRAVITY_TIMEOUT = 3,
    ATTITUDE_RECOVERING = 4
} attitude_state_t;
#define ATTITUDE_GRAVITY_TIMEOUT_S 10.f
#define ATTITUDE_RECOVER_S 0.5f
void attitude_init(void);
bool attitude_update(const float gyro[3],const float acc[3],float dt);
const float *attitude_degrees(void);
bool attitude_ready(void);
attitude_state_t attitude_state(void);
const char *attitude_state_name(void);
void attitude_setpoint(const float sticks[4],float out[3]);
#endif
