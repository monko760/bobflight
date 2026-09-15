/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host edge cases: high-throttle refuse; failsafe mid-air disarm.
 * Provides Drivers stubs; links flight arming + failsafe only.
 */
#include "flight/arming.h"
#include "flight/failsafe.h"

#include <stdbool.h>
#include <stdio.h>
#include <string.h>

/* --- Drivers stubs --- */
static bool g_gyro_live = true;
static float g_rc[16];
static bool cal_ready=true;
static bool rate_only_req=false, rate_ready=true;
bool gyro_flight_ready(void){return cal_ready;}
bool gyro_rate_ready(void){return rate_ready;}
bool arming_rate_only(void){return rate_only_req;}
bool rx_frame_fresh(void){return true;}

bool gyro_is_healthy(void)
{
    return g_gyro_live;
}

const float *rx_channels(void)
{
    return g_rc;
}

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

int main(void)
{
    memset(g_rc, 0, sizeof(g_rc));

    /* High throttle refuse */
    arming_init();
    failsafe_init();
    g_gyro_live = true;
    arming_set_gyro_healthy(true);
    g_rc[3] = 0.20f;
    if (arming_try_arm()) {
        return fail("should refuse high throttle");
    }
    if (arming_state() != ARM_DISARMED) {
        return fail("still disarmed after high-thr refuse");
    }

    if (!failsafe_active() || arming_try_arm()) return fail("startup must block without RX");
    failsafe_note_rx_frame(0u);
    failsafe_tick(0u);
    if (failsafe_active()) return fail("frame at timestamp zero must be valid");
#if defined(BOBFLIGHT_MCU)
    /* Mode-aware sensor gate: Acro is gyro-only. */
    g_rc[3] = 0.0f;
    rate_only_req = true; cal_ready = false; rate_ready = true;
    if (!arming_try_arm()) return fail("rate-only arming must not require qualified accel");
    if (arming_state() != ARM_ARMED) return fail("rate-only arm did not arm");
    arming_disarm();
    rate_ready = false;
    if (arming_try_arm()) return fail("rate-only arming must require live gyro samples");
    rate_ready = true;
    rate_only_req = false; /* leveled mode falls back to the full gravity gate */
    if (arming_try_arm()) return fail("leveled mode must still require qualified accel");
#endif

#if defined(BOBFLIGHT_MCU)
    /* Even with otherwise valid gyro/RX, independent gyro calibration must
     * not bypass the stricter accelerometer/gravity pre-arm gate. */
    g_rc[3]=0.f;cal_ready=false;
    if(arming_try_arm())return fail("gyro bias alone must not permit MCU arming");
    cal_ready=true;
#endif
    /* Low throttle + healthy → arm */
    g_rc[3] = 0.0f;
    if (!arming_try_arm()) {
        return fail("should arm with low thr + healthy gyro");
    }
    if (arming_state() != ARM_ARMED) {
        return fail("expected ARMED");
    }

    /* Failsafe mid-air → disarm (mixer/dshot path then zeros motors) */
    failsafe_note_rx_frame(100u);
    failsafe_tick(100u + 251u);
    if (!failsafe_active()) {
        return fail("failsafe should be active");
    }
    if (arming_state() != ARM_DISARMED) {
        return fail("failsafe should disarm");
    }

    /* Cannot re-arm while failsafe active */
    g_rc[3] = 0.0f;
    if (arming_try_arm()) {
        return fail("must refuse arm while failsafe active");
    }

    puts("PASS: arming edge cases (throttle + failsafe disarm)");
    return 0;
}
