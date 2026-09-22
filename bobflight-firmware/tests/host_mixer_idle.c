/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit test: min_throttle floors stick throttle and post-mix motors while
 * the mixer runs (armed path). ARMING_THROTTLE_MAX is independent. Not flight-qualified.
 */
#include "flight/mixer.h"
#include "flight/config.h"
#include "flight/pid.h"
#include <math.h>
#include <stdio.h>

static int fail(const char *m){fprintf(stderr,"FAIL host_mixer_idle: %s\n",m);return 1;}
static int near(float a,float b){return fabsf(a-b)<1e-5f;}

int main(void)
{
    float motors[MIXER_MOTOR_COUNT];
    pid_axis_out_t pid = {0.f, 0.f, 0.f};

    config_init();
    mixer_init();

    /* Default min_throttle 0.05: zero stick → all motors at idle floor. */
    mixer_update(&pid, 0.f, motors);
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        if (!near(motors[i], 0.05f)) {
            fprintf(stderr, "m%d=%g\n", i, (double)motors[i]);
            return fail("default idle floor 0.05");
        }
    }

    /* Stick above floor unchanged in common mode. */
    mixer_update(&pid, 0.4f, motors);
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        if (!near(motors[i], 0.4f)) return fail("thr 0.4 passthrough");
    }

    /* min_throttle 0: allow true zero (bench / props-off). */
    if (!config_set_key("min_throttle", 0.f)) return fail("set mt 0");
    mixer_update(&pid, 0.f, motors);
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        if (!near(motors[i], 0.f)) return fail("mt0 allows zero");
    }

    /* Post-mix floor: PID that would drive a motor below idle. */
    if (!config_set_key("min_throttle", 0.08f)) return fail("set mt 0.08");
    pid.roll = 0.2f;
    mixer_update(&pid, 0.1f, motors);
    for (int i = 0; i < MIXER_MOTOR_COUNT; i++) {
        if (motors[i] + 1e-6f < 0.08f) {
            fprintf(stderr, "m%d=%g below floor\n", i, (double)motors[i]);
            return fail("post-mix floor");
        }
    }

    /* Range reject */
    if (config_set_key("min_throttle", 0.25f)) return fail("mt>0.2 should fail");
    if (config_set_key("min_throttle", -0.01f)) return fail("mt<0 should fail");

    puts("PASS host_mixer_idle: min_throttle stick+post-mix floor");
    return 0;
}
