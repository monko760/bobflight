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
#include <stddef.h>

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

/* N2: every check arming_try_arm() applies, as the first failing token
 * (NULL when it would arm). Pure: never changes the arm state. The switch
 * path (tasks.c loop_pid) and the CLI `arm` refusal both read this, so the
 * two can never disagree about what blocks arming. */
const char *arming_block_reason(void)
{
#if BOBFLIGHT_ACCEL_BENCH_RELAXED
    /* Independently fail closed even if another caller bypasses gyro readiness. */
    return "bench-build";
#endif
#if defined(BOBFLIGHT_MCU)
    /* Sensor-only targets (no motor backend) cannot arm. */
#if !defined(BOBFLIGHT_FLIGHT_ENABLE) || !BOBFLIGHT_FLIGHT_ENABLE
    return "no-motor-output";
#endif
    if(!rx_frame_fresh())return "receiver-stale";
    /* Mode-aware readiness: Acro is rate-only and never needs the accelerometer.
     * Angle/Horizon still require qualified gravity for leveling. */
    if(!arming_rate_only()){ if(!gyro_flight_ready())return "gravity-not-ready"; }
    else { if(!gyro_rate_ready())return "gyro-not-ready"; }
#endif
    if (!gyro_is_healthy() || !g_gyro_ok) {
        return "gyro-unhealthy";
    }
    if (failsafe_active()) {
        return "failsafe";
    }
    {
        const float *rc = rx_channels();
        float thr = rc ? rc[3] : 1.f; /* missing RX → refuse */
        if (!isfinite(thr) || thr < 0.f || thr > ARMING_THROTTLE_MAX) {
            return "throttle-not-low";
        }
    }
    return NULL;
}

bool arming_try_arm(void)
{
    if (arming_block_reason() != NULL) {
        return false;
    }
    g_arm = ARM_ARMED;
    return true;
}

void arming_disarm(void)
{
    g_arm = ARM_DISARMED;
}
