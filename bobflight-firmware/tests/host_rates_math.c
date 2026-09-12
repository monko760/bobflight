/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit checks for rates_curve_map (no MCU).
 */
#include "flight/rates.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

int main(void)
{
    if (fabsf(rates_curve_map(0.f, RATES_MAX_DPS)) > 1e-5f) {
        return fail("center not ~0");
    }
    if (fabsf(rates_curve_map(0.015f, RATES_MAX_DPS)) > 1e-5f) {
        return fail("inside deadband should be 0");
    }
    if (fabsf(rates_curve_map(1.f, RATES_MAX_DPS) - RATES_MAX_DPS) > 1e-3f) {
        return fail("full +stick not +max");
    }
    if (fabsf(rates_curve_map(-1.f, RATES_MAX_DPS) + RATES_MAX_DPS) > 1e-3f) {
        return fail("full -stick not -max");
    }
    /* Over-range clamps to full */
    if (fabsf(rates_curve_map(1.5f, RATES_MAX_DPS) - RATES_MAX_DPS) > 1e-3f) {
        return fail("+over-range not +max");
    }
    if (fabsf(rates_curve_map(-1.5f, RATES_MAX_DPS) + RATES_MAX_DPS) > 1e-3f) {
        return fail("-over-range not -max");
    }
    /* Odd symmetry */
    {
        float p = rates_curve_map(0.4f, RATES_MAX_DPS);
        float n = rates_curve_map(-0.4f, RATES_MAX_DPS);
        if (fabsf(p + n) > 1e-4f) {
            return fail("curve not odd-symmetric");
        }
    }
    /* Expo softens mid vs linear-after-deadband ballpark */
    {
        float mid = rates_curve_map(0.5f, RATES_MAX_DPS);
        float linear = 0.5f * RATES_MAX_DPS;
        if (!(mid < linear - 1.f)) {
            return fail("expo mid should be below linear");
        }
    }
    /* rates_update wiring + null rc zeros */
    {
        float rc[4] = {1.f, -1.f, 0.f, 0.5f};
        float sp[3] = {9.f, 9.f, 9.f};
        rates_update(rc, sp);
        if (fabsf(sp[0] - RATES_MAX_DPS) > 1e-3f || fabsf(sp[1] + RATES_MAX_DPS) > 1e-3f ||
            fabsf(sp[2]) > 1e-5f) {
            return fail("rates_update axes");
        }
        rates_update(NULL, sp);
        if (fabsf(sp[0]) > 1e-5f || fabsf(sp[1]) > 1e-5f || fabsf(sp[2]) > 1e-5f) {
            return fail("null rc should zero setpoints");
        }
    }
    puts("PASS: rates curve / RC scaling host math");
    return 0;
}
