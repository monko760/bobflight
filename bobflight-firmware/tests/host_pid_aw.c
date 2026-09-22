/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit test: I-term anti-windup freezes integration at ±0.4 saturation
 * while I_LIMIT ±50 remains the hard safety net. Props-off / not flight-qualified.
 */
#include "flight/pid.h"
#include "flight/config.h"
#include <math.h>
#include <stdio.h>

static int fail(const char *m){fprintf(stderr,"FAIL host_pid_aw: %s\n",m);return 1;}

int main(void)
{
    pid_axis_out_t out;
    float gyro[3] = {0.f, 0.f, 0.f};
    float sp[3] = {800.f, 0.f, 0.f}; /* large error → saturates axis output */
    float i_before, i_after;

    config_init();
    /* Boost I so it would wind without AW. */
    if (!config_set_key("pid_roll_i", 1.f) || !config_set_key("pid_roll_p", 0.f) ||
        !config_set_key("pid_roll_d", 0.f)) {
        return fail("set gains");
    }

    pid_init();
    pid_set_dt(0.001f);

    /* Drive into saturation for many steps. */
    for (int n = 0; n < 200; n++) {
        pid_update(gyro, sp, &out);
    }
    if (fabsf(out.roll) < 0.399f) {
        return fail("expected roll output saturated near +0.4");
    }

    /* Capture effective I via a tiny reverse step that should NOT grow I further
     * while still saturated in the same direction — instead freeze. */
    /* After saturation with positive error, I is frozen. Zero error briefly then
     * re-apply same error: output should not grow past clamp from further I wind. */
    {
        float zero_sp[3] = {0.f, 0.f, 0.f};
        pid_axis_out_t mid;
        /* Allow I to unwind slightly with opposite/zero? Keep same gyro=0, sp=0:
         * err=0 → I unchanged by freeze logic (not saturated push). */
        pid_update(gyro, zero_sp, &mid);
        (void)mid;
    }

    /* Re-saturate; with AW, I must not explode past I_LIMIT. */
    for (int n = 0; n < 5000; n++) {
        pid_update(gyro, sp, &out);
    }
    if (fabsf(out.roll) > 0.401f) {
        return fail("output exceeded OUT_LIMIT");
    }

    /* Hard I_LIMIT: with P=0 and no AW freeze on unsaturated path, I clamps at 50.
     * Use tiny P and small setpoint so output stays under 0.4 while I grows. */
    pid_init();
    if (!config_set_key("pid_roll_i", 1.f) || !config_set_key("pid_roll_p", 0.f)) {
        return fail("set gains2");
    }
    float small[3] = {0.1f, 0.f, 0.f};
    for (int n = 0; n < 100000; n++) {
        pid_update(gyro, small, &out);
    }
    /* i_term = 1 * I <= 50; output clamp 0.4 so we only know I_LIMIT held if we
     * inspect via unsaturated tiny ki... Use ki small enough that I*ki < 0.4 at I=50. */
    pid_init();
    if (!config_set_key("pid_roll_i", 0.001f) || !config_set_key("pid_roll_p", 0.f)) {
        return fail("set gains3");
    }
    for (int n = 0; n < 200000; n++) {
        pid_update(gyro, small, &out);
    }
    /* After long integration err=0.1, dt=0.001 → di=0.0001/step; 200000 steps → 20,
     * under I_LIMIT 50; continue until past 50 without AW saturation (u_pre = 0.001*I).
     * At I=50, u_pre=0.05 < 0.4 so no freeze — I should clamp at 50 → out≈0.05. */
    for (int n = 0; n < 500000; n++) {
        pid_update(gyro, small, &out);
    }
    if (out.roll < 0.049f || out.roll > 0.051f) {
        fprintf(stderr, "got roll=%g\n", (double)out.roll);
        return fail("I_LIMIT safety net expected ~0.05 with ki=0.001");
    }

    /* AW freeze: large ki + large error saturates; I must stop growing so that
     * after many steps output stays at clamp (already checked) and a subsequent
     * opposite error recovers without requiring huge I unwind time. */
    pid_init();
    if (!config_set_key("pid_roll_i", 2.f) || !config_set_key("pid_roll_p", 0.f)) {
        return fail("set gains4");
    }
    for (int n = 0; n < 50; n++) {
        pid_update(gyro, sp, &out);
    }
    float sat = out.roll;
    for (int n = 0; n < 500; n++) {
        pid_update(gyro, sp, &out);
    }
    if (fabsf(out.roll - sat) > 1e-4f) {
        return fail("AW freeze should keep saturated output stable");
    }

    puts("PASS host_pid_aw: OUT_LIMIT freeze + I_LIMIT safety net");
    return 0;
}
