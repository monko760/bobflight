/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host cascade integration: gyro_host_inject_dps → rates/pid/mixer (+ arm).
 * Not the full bobflight_host main loop.
 */
#include "board/board.h"
#include "drivers/gyro.h"
#include "drivers/rx.h"
#include "drivers/rx_internal.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "flight/mixer.h"
#include "flight/pid.h"
#include "flight/config.h"
#include "flight/rates.h"
#include "hal/hal.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

static int near(float a, float b, float eps)
{
    return fabsf(a - b) <= eps;
}

int main(void)
{
    float inj[3] = {100.f, -50.f, 25.f};
    float dps[3];
    float filt[3];
    float rc[4] = {0.f, 0.f, 0.f, 0.f}; /* rates → zero setpoint */
    float sp[3];
    float motors[MIXER_MOTOR_COUNT];
    pid_axis_out_t pid;
    const float thr = 0.4f;

    /* Expected first-sample PID (D=0) with static gains in pid.c */
    const float exp_roll = -0.200025f;
    const float exp_pitch = 0.1000125f;
    const float exp_yaw = -0.05000625f;
    const float exp_m0 = 0.75004375f;
    const float exp_m1 = 0.45000625f;
    const float exp_m2 = 0.24998125f;
    const float exp_m3 = 0.14996875f;
    const float eps = 1e-4f;

    hal_clock_init(0);
    hal_time_init();
    if (!board_init()) {
        return fail("board_init");
    }

    gyro_init();
    arming_init();
    failsafe_init();
    rates_init();
    pid_init();
    mixer_init();

    /* Low throttle for arm attempts */
    {
        float ch[16];
        memset(ch, 0, sizeof(ch));
        ch[3] = 0.f;
        rx_stub_set_channels(ch, 16, true);
    }

    /* --- healthy inject → rates → pid → mixer --- */
    gyro_host_inject_dps(inj, true);
    if (!gyro_is_healthy()) {
        return fail("inject healthy");
    }
    if (!gyro_sample(dps)) {
        return fail("sample after inject");
    }
    if (!near(dps[0], inj[0], 1e-6f) || !near(dps[1], inj[1], 1e-6f) ||
        !near(dps[2], inj[2], 1e-6f)) {
        return fail("sampled dps != inject");
    }

    rates_update(rc, sp);
    if (!near(sp[0], 0.f, 1e-5f) || !near(sp[1], 0.f, 1e-5f) || !near(sp[2], 0.f, 1e-5f)) {
        return fail("zero RC should yield zero setpoint");
    }

    gyro_filter(dps, filt);
    pid_update(filt, sp, &pid);
    if (!near(pid.roll, exp_roll, eps) || !near(pid.pitch, exp_pitch, eps) ||
        !near(pid.yaw, exp_yaw, eps)) {
        fprintf(stderr, "pid got %g %g %g\n", pid.roll, pid.pitch, pid.yaw);
        return fail("pid vector");
    }
    if (!isfinite(pid.roll) || !isfinite(pid.pitch) || !isfinite(pid.yaw)) {
        return fail("pid non-finite");
    }

    mixer_update(&pid, thr, motors);
    if (!near(motors[0], exp_m0, eps) || !near(motors[1], exp_m1, eps) ||
        !near(motors[2], exp_m2, eps) || !near(motors[3], exp_m3, eps)) {
        fprintf(stderr, "motors got %g %g %g %g\n", motors[0], motors[1], motors[2],
                motors[3]);
        return fail("mixer vector");
    }
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        if (!isfinite(motors[i]) || motors[i] < 0.f || motors[i] > 1.f) {
            return fail("motor out of [0,1] or non-finite");
        }
    }

    /* Arm allowed when healthy + low thr + no failsafe */
    if (!arming_try_arm()) {
        return fail("should arm after healthy inject");
    }
    if (arming_state() != ARM_ARMED) {
        return fail("expected ARMED");
    }
    arming_disarm();

    /* --- live CLI key → PID (2× roll P) --- */
    pid_init();
    if (!config_set_key("pid_roll_p", 0.004f)) {
        return fail("set pid_roll_p");
    }
    pid_update(filt, sp, &pid);
    if (!near(pid.roll, 2.f * exp_roll, eps)) {
        fprintf(stderr, "live pid.roll %g expected %g\n", pid.roll, 2.f * exp_roll);
        return fail("pid_roll_p CLI key not live in pid_update");
    }
    (void)config_set_key("pid_roll_p", 0.002f); /* restore default */

    /* --- fail-closed inject --- */
    gyro_host_inject_dps(inj, false);
    if (gyro_is_healthy()) {
        return fail("unhealthy inject still healthy");
    }
    if (gyro_sample(dps)) {
        return fail("sample must fail when unhealthy");
    }
    if (arming_try_arm()) {
        return fail("arm must refuse when gyro unhealthy");
    }
    if (arming_state() != ARM_DISARMED) {
        return fail("must stay disarmed");
    }

    puts("PASS: host cascade inject → rates/pid/mixer (+ arm fail-closed)");
    return 0;
}
