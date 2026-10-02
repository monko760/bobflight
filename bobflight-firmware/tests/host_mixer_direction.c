/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit test: motor_direction (schema 10) in the real QUADX mixer.
 * props-out must reproduce the pre-setting mixer (flight/mixer.c lines 52-56 at
 * 870e601) bit for bit; props-in must be exactly that mixer with the yaw term
 * negated on all four motors. Also: the `mixer` report sign table matches
 * mixer_update, a change applies on the next call, and the real rate PID's
 * response to a yaw rate speeds up the opposite motor pair for props-in.
 * Not flight-qualified: no hardware, no props.
 */
#include "flight/mixer.h"
#include "flight/config.h"
#include "flight/pid.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "FAIL host_mixer_direction line %d: %s\n", __LINE__, #x); return 1; } } while (0)

static float clampf(float v, float lo, float hi) { return v < lo ? lo : v > hi ? hi : v; }

/* Reference: the mixer body as it was at 870e601 (mixer.c:52-56 plus the clamp/idle floor). */
static void reference_mix(float roll, float pitch, float yaw, float throttle, float out[4])
{
    const float mt = clampf(config_get()->min_throttle, 0.f, 0.2f);
    float thr = clampf(throttle, 0.f, 1.f);
    if (thr < mt) thr = mt;
    out[0] = thr - roll + pitch - yaw; /* rear-right */
    out[1] = thr - roll - pitch + yaw; /* front-right */
    out[2] = thr + roll + pitch + yaw; /* rear-left */
    out[3] = thr + roll - pitch - yaw; /* front-left */
    for (int i = 0; i < 4; i++) {
        out[i] = clampf(out[i], 0.f, 1.f);
        if (mt > 0.f && out[i] < mt) out[i] = mt;
    }
}

static int same_bits(const float a[4], const float b[4]) { return memcmp(a, b, 4 * sizeof(float)) == 0; }

int main(void)
{
    float m[4], ref[4];
    config_init();
    mixer_init();
    CHECK(config_motor_direction() == MOTOR_DIRECTION_PROPS_OUT); /* default */

    /* 1. Bit-identical to the pre-setting mixer (props-out) / yaw negated (props-in). */
    static const float v[] = {-0.7f, -0.25f, -0.013f, 0.f, 0.0071f, 0.3f, 0.65f};
    static const float t[] = {0.f, 0.04f, 0.2f, 0.5f, 0.93f, 1.f};
    unsigned cases = 0;
    for (unsigned d = 0; d < 2; d++) {
        CHECK(config_set_motor_direction(d ? MOTOR_DIRECTION_PROPS_IN : MOTOR_DIRECTION_PROPS_OUT));
        for (unsigned a = 0; a < 7; a++) for (unsigned b = 0; b < 7; b++) for (unsigned c = 0; c < 7; c++) for (unsigned k = 0; k < 6; k++) {
            const pid_axis_out_t pid = {v[a], v[b], v[c]};
            mixer_update(&pid, t[k], m);
            reference_mix(v[a], v[b], d ? -v[c] : v[c], t[k], ref);
            if (!same_bits(m, ref)) {
                fprintf(stderr, "dir %u roll %g pitch %g yaw %g thr %g: got %g %g %g %g want %g %g %g %g\n", d,
                        (double)v[a], (double)v[b], (double)v[c], (double)t[k], (double)m[0], (double)m[1], (double)m[2],
                        (double)m[3], (double)ref[0], (double)ref[1], (double)ref[2], (double)ref[3]);
                return 1;
            }
            cases++;
        }
    }

    /* 2. Both signs, explicit numbers (thr 0.5, yaw +0.1 only). */
    const pid_axis_out_t yaw_only = {0.f, 0.f, 0.1f};
    CHECK(config_set_motor_direction(MOTOR_DIRECTION_PROPS_OUT));
    mixer_update(&yaw_only, 0.5f, m);
    CHECK(fabsf(m[0] - 0.4f) < 1e-6f && fabsf(m[1] - 0.6f) < 1e-6f && fabsf(m[2] - 0.6f) < 1e-6f && fabsf(m[3] - 0.4f) < 1e-6f);
    CHECK(mixer_yaw_direction() == 1.f);
    CHECK(mixer_yaw_sign(0) == -1 && mixer_yaw_sign(1) == +1 && mixer_yaw_sign(2) == +1 && mixer_yaw_sign(3) == -1);
    /* 3. Applies on the very next call, no re-init. */
    CHECK(config_set_motor_direction(MOTOR_DIRECTION_PROPS_IN));
    mixer_update(&yaw_only, 0.5f, m);
    CHECK(fabsf(m[0] - 0.6f) < 1e-6f && fabsf(m[1] - 0.4f) < 1e-6f && fabsf(m[2] - 0.4f) < 1e-6f && fabsf(m[3] - 0.6f) < 1e-6f);
    CHECK(mixer_yaw_direction() == -1.f);
    CHECK(mixer_yaw_sign(0) == +1 && mixer_yaw_sign(1) == -1 && mixer_yaw_sign(2) == -1 && mixer_yaw_sign(3) == +1);
    CHECK(mixer_yaw_sign(4) == 0);

    /* 4. The report's sign table is what mixer_update does, for both settings. */
    for (unsigned d = 0; d < 2; d++) {
        CHECK(config_set_motor_direction(d ? MOTOR_DIRECTION_PROPS_IN : MOTOR_DIRECTION_PROPS_OUT));
        float base[4];
        const pid_axis_out_t none = {0.f, 0.f, 0.f};
        mixer_update(&none, 0.5f, base);
        mixer_update(&yaw_only, 0.5f, m);
        for (unsigned i = 0; i < 4; i++) CHECK((m[i] > base[i] ? +1 : -1) == mixer_yaw_sign(i));
    }

    /* 5. Bench-test analog with the real rate PID: a yaw rate with zero setpoint
     *    (the frame turned by hand) speeds up one diagonal pair; props-in speeds up
     *    the other pair. Which physical pair spins clockwise is the bench test's job. */
    for (unsigned d = 0; d < 2; d++) {
        CHECK(config_set_motor_direction(d ? MOTOR_DIRECTION_PROPS_IN : MOTOR_DIRECTION_PROPS_OUT));
        pid_init();
        const float gyro[3] = {0.f, 0.f, 120.f}, sp[3] = {0.f, 0.f, 0.f};
        pid_axis_out_t out;
        pid_update(gyro, sp, &out);
        CHECK(out.yaw < 0.f && out.roll == 0.f && out.pitch == 0.f);
        float base[4];
        const pid_axis_out_t none = {0.f, 0.f, 0.f};
        mixer_update(&none, 0.3f, base);
        mixer_update(&out, 0.3f, m);
        if (!d) CHECK(m[0] > base[0] && m[3] > base[3] && m[1] < base[1] && m[2] < base[2]);
        else    CHECK(m[1] > base[1] && m[2] > base[2] && m[0] < base[0] && m[3] < base[3]);
    }

    /* 6. Invalid values are refused and leave the setting unchanged; defaults restore props-out. */
    CHECK(config_set_motor_direction(MOTOR_DIRECTION_PROPS_IN));
    CHECK(!config_set_motor_direction((motor_direction_t)2) && config_motor_direction() == MOTOR_DIRECTION_PROPS_IN);
    motor_direction_t parsed = MOTOR_DIRECTION_PROPS_OUT;
    CHECK(config_motor_direction_parse("props-in", &parsed) && parsed == MOTOR_DIRECTION_PROPS_IN);
    CHECK(config_motor_direction_parse("props-out", &parsed) && parsed == MOTOR_DIRECTION_PROPS_OUT);
    static const char *const bad[] = {"", "props_in", "PROPS-IN", "props-in ", " props-out", "in", "1", "props-inward"};
    for (unsigned i = 0; i < sizeof bad / sizeof bad[0]; i++) CHECK(!config_motor_direction_parse(bad[i], &parsed));
    CHECK(!config_motor_direction_parse(NULL, &parsed));
    config_defaults();
    CHECK(config_motor_direction() == MOTOR_DIRECTION_PROPS_OUT);

    printf("PASS host_mixer_direction: props-out == 870e601 mixer bit-for-bit, props-in == yaw negated (%u cases), both signs, immediate apply, report table, PID bench analog, parse/refuse/defaults\n", cases);
    return 0;
}
