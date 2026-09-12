/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "flight/arming.h"
#include "drivers/calibration_policy.h"
#include "flight/failsafe.h"
#include "drivers/gyro.h"
#include "drivers/rx.h"
#include <math.h>

static arm_state_t g_arm = ARM_DISARMED;
static bool g_gyro_ok = false;

void arming_init(void)
{
    g_arm = ARM_DISARMED;
    g_gyro_ok = false;
}

arm_state_t arming_state(void)
{
    return g_arm;
}

void arming_set_gyro_healthy(bool healthy)
{
    g_gyro_ok = healthy;
    if (!healthy && g_arm == ARM_ARMED) {
        g_arm = ARM_DISARMED;
    }
}

bool arming_try_arm(void)
{
#if BOBFLIGHT_ACCEL_BENCH_RELAXED
    /* Independently fail closed even if another caller bypasses gyro readiness. */
    return false;
#endif
#if defined(BOBFLIGHT_MCU)
    /* Bench image cannot arm; enable only after axis/motor bench validation. */
#if !defined(BOBFLIGHT_FLIGHT_ENABLE) || !BOBFLIGHT_FLIGHT_ENABLE
    return false;
#endif
    /* Stationary gyro bias alone is insufficient to validate accelerometer gravity. */
    if(!gyro_flight_ready() || !rx_frame_fresh())return false;
#endif
    if (!gyro_is_healthy() || !g_gyro_ok) {
        return false;
    }
    if (failsafe_active()) {
        return false;
    }
    {
        const float *rc = rx_channels();
        float thr = rc ? rc[3] : 1.f; /* missing RX → refuse */
        if (!isfinite(thr) || thr < 0.f || thr > ARMING_THROTTLE_MAX) {
            return false;
        }
    }
    g_arm = ARM_ARMED;
    return true;
}

void arming_disarm(void)
{
    g_arm = ARM_DISARMED;
}
