/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit test: motor_direction (schema 10) in the real QUADX mixer.
 * No copy of the mixer is kept here (a copy can silently mirror a bug, #63 QA):
 *  - symmetry: props-in with PID yaw y gives exactly (bit for bit) the props-out
 *    output for yaw -y, over a grid that includes saturating inputs, airmode 0/1
 *    and several min_throttle values; whatever the mixer does (clamp, idle floor,
 *    desaturation), motor_direction only flips the sign of the yaw input;
 *  - an independent literal QUADX sign table (M1 RR, M2 FR, M3 RL, M4 FL) in the
 *    unsaturated range pins roll/pitch/yaw signs for both settings.
 * Also: the `mixer` report sign table matches mixer_update, a change applies on
 * the next call, and the real rate PID's response to a yaw rate speeds up the
 * opposite motor pair for props-in. Not flight-qualified: no hardware, no props.
 */
#include "flight/mixer.h"
#include "flight/config.h"
#include "flight/pid.h"
#include <math.h>
#include <stdio.h>
#include <string.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "FAIL host_mixer_direction line %d: %s\n", __LINE__, #x); return 1; } } while (0)

static int same_bits(const float a[4], const float b[4]) { return memcmp(a, b, 4 * sizeof(float)) == 0; }

int main(void)
{
    float m[4], ref[4];
    config_init();
    mixer_init();
    CHECK(config_motor_direction() == MOTOR_DIRECTION_PROPS_OUT); /* default */

    /* 1a. Symmetry: props-in(r, p, y) == props-out(r, p, -y), bit for bit, saturating cases included. */
    static const float v[] = {-0.9f, -0.5f, -0.2f, -0.013f, 0.f, 0.0071f, 0.2f, 0.5f, 0.9f};
    static const float t[] = {0.f, 0.04f, 0.05f, 0.1f, 0.3f, 0.5f, 0.8f, 0.95f, 1.f};
    static const float mts[] = {0.f, 0.05f, 0.2f};
    unsigned cases = 0, saturated = 0;
    for (unsigned air = 0; air < 2; air++) for (unsigned q = 0; q < 3; q++) {
        CHECK(config_set_key("airmode", (float)air));
        CHECK(config_set_key("min_throttle", mts[q]));
        for (unsigned a = 0; a < 9; a++) for (unsigned b = 0; b < 9; b++) for (unsigned c = 0; c < 9; c++) for (unsigned k = 0; k < 9; k++) {
            const pid_axis_out_t pin = {v[a], v[b], v[c]}, pout = {v[a], v[b], -v[c]};
            CHECK(config_set_motor_direction(MOTOR_DIRECTION_PROPS_IN));
            mixer_update(&pin, t[k], m);
            CHECK(config_set_motor_direction(MOTOR_DIRECTION_PROPS_OUT));
            mixer_update(&pout, t[k], ref);
            if (!same_bits(m, ref)) {
                fprintf(stderr, "airmode %u min_throttle %g roll %g pitch %g yaw %g thr %g: props-in %g %g %g %g != props-out(-yaw) %g %g %g %g\n",
                        air, (double)mts[q], (double)v[a], (double)v[b], (double)v[c], (double)t[k], (double)m[0], (double)m[1],
                        (double)m[2], (double)m[3], (double)ref[0], (double)ref[1], (double)ref[2], (double)ref[3]);
                return 1;
            }
            const float raw = t[k] + fabsf(v[a]) + fabsf(v[b]) + fabsf(v[c]);
            if (raw > 1.f || t[k] - fabsf(v[a]) - fabsf(v[b]) - fabsf(v[c]) < 0.f) saturated++;
            cases++;
        }
    }
    CHECK(saturated > cases / 4); /* the grid really exercises clamping / desaturation */
    config_init();
    mixer_init();

    /* 1b. Literal QUADX signs (independent of mixer.c), unsaturated range only:
     *     motor = thr + sr*roll + sp*pitch + d*sy*yaw, d = +1 props-out, -1 props-in. */
    static const int sr[4] = {-1, -1, +1, +1}, sp[4] = {+1, -1, +1, -1}, sy[4] = {-1, +1, +1, -1};
    static const float u[] = {-0.1f, -0.03f, 0.f, 0.05f, 0.1f};
    static const float ut[] = {0.4f, 0.5f, 0.6f};
    unsigned literal = 0;
    for (unsigned air = 0; air < 2; air++) for (unsigned d = 0; d < 2; d++) {
        CHECK(config_set_key("airmode", (float)air));
        CHECK(config_set_motor_direction(d ? MOTOR_DIRECTION_PROPS_IN : MOTOR_DIRECTION_PROPS_OUT));
        const float dir = d ? -1.f : 1.f;
        for (unsigned a = 0; a < 5; a++) for (unsigned b = 0; b < 5; b++) for (unsigned c = 0; c < 5; c++) for (unsigned k = 0; k < 3; k++) {
            const pid_axis_out_t pid = {u[a], u[b], u[c]};
            mixer_update(&pid, ut[k], m);
            for (unsigned i = 0; i < 4; i++) {
                const float want = ut[k] + (float)sr[i] * u[a] + (float)sp[i] * u[b] + dir * (float)sy[i] * u[c];
                if (fabsf(m[i] - want) > 1e-5f) {
                    fprintf(stderr, "literal: airmode %u dir %u M%u roll %g pitch %g yaw %g thr %g: got %g want %g\n", air, d, i + 1,
                            (double)u[a], (double)u[b], (double)u[c], (double)ut[k], (double)m[i], (double)want);
                    return 1;
                }
            }
            literal++;
        }
    }
    config_init();
    mixer_init();

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

    printf("PASS host_mixer_direction: props-in(r,p,y) == props-out(r,p,-y) bit-for-bit (%u cases, %u saturating, airmode 0/1, 3 min_throttle), literal QUADX sign table (%u cases), both signs, immediate apply, report table, PID bench analog, parse/refuse/defaults\n", cases, saturated, literal);
    return 0;
}
