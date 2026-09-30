/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "sched/loop_rate_setting.h"
#include "sched/loop_rate.h"
#include <string.h>

/* 0 = board default (resolved on read, so defaults follow the board). */
static uint32_t g_setting_hz;

uint32_t loop_rate_setting_default_hz(void)
{
    return loop_rate_board_fast(board_get()) ? LOOP_RATE_SETTING_4K : LOOP_RATE_SETTING_1K;
}

bool loop_rate_setting_allowed(uint32_t hz)
{
    return hz == LOOP_RATE_SETTING_1K || hz == LOOP_RATE_SETTING_4K || hz == LOOP_RATE_SETTING_8K;
}

bool loop_rate_setting_wants_8k_gyro(uint32_t hz)
{
    return hz == LOOP_RATE_SETTING_4K || hz == LOOP_RATE_SETTING_8K;
}

const char *loop_rate_setting_unsupported_reason(uint32_t hz)
{
    if (!loop_rate_setting_allowed(hz)) return "not-1000-4000-8000";
    if (loop_rate_setting_wants_8k_gyro(hz) && !loop_rate_board_fast(board_get()))
        return "board-has-no-8k-gyro-path";
    return NULL;
}

bool loop_rate_setting_parse(const char *text, uint32_t *out)
{
    static const struct { const char *text; uint32_t hz; } k[] = {
        {"1000", LOOP_RATE_SETTING_1K}, {"4000", LOOP_RATE_SETTING_4K}, {"8000", LOOP_RATE_SETTING_8K}};
    if (!text || !out) return false;
    for (unsigned i = 0; i < sizeof k / sizeof k[0]; ++i) {
        if (strcmp(text, k[i].text) == 0) { *out = k[i].hz; return true; }
    }
    return false;
}

bool loop_rate_setting_set(uint32_t hz)
{
    if (loop_rate_setting_unsupported_reason(hz)) return false;
    g_setting_hz = hz;
    return true;
}

uint32_t loop_rate_setting_get(void)
{
    return g_setting_hz ? g_setting_hz : loop_rate_setting_default_hz();
}

void loop_rate_setting_defaults(void) { g_setting_hz = 0u; }
