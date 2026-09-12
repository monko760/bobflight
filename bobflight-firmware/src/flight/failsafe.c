/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "flight/failsafe.h"
#include "flight/arming.h"
#include "drivers/rx.h"

#include <math.h>

/* No fresh frame for this long → link is stale. */
#define FAILSAFE_RX_TIMEOUT_MS 250u
/* Defaults: baseline-preserving (immediate DROP once stale). */
#define FAILSAFE_DEFAULT_HOLD_MS 0u
#define FAILSAFE_DEFAULT_LAND_MS 3000u
#define FAILSAFE_DEFAULT_LAND_THROTTLE 0.35f

static bool g_never_seen;
static failsafe_stage_t g_stage;
static uint32_t g_last_rx_ms;
static uint32_t g_stage_ms; /* when the current stage was entered */
static float g_held_thr;

static failsafe_action_t g_action;
static uint32_t g_hold_ms;
static uint32_t g_land_ms;
static float g_land_thr;

static void failsafe_enter(uint32_t now_ms, failsafe_stage_t stage)
{
    g_stage = stage;
    g_stage_ms = now_ms;
}

static float failsafe_capture_throttle(void)
{
    const float *rc = rx_channels();
    if (!rc) {
        return 0.f;
    }
    float thr = rc[3];
    if (!isfinite(thr) || thr < 0.f) {
        return 0.f;
    }
    if (thr > 1.f) {
        thr = 1.f;
    }
    return thr;
}

void failsafe_init(void)
{
    g_never_seen = true;
    g_stage = FAILSAFE_STAGE_IDLE;
    g_last_rx_ms = 0;
    g_stage_ms = 0;
    g_held_thr = 0.f;
    g_action = FAILSAFE_ACTION_DROP;
    g_hold_ms = FAILSAFE_DEFAULT_HOLD_MS;
    g_land_ms = FAILSAFE_DEFAULT_LAND_MS;
    g_land_thr = FAILSAFE_DEFAULT_LAND_THROTTLE;
}

void failsafe_reset_rx_link(void)
{
    g_never_seen = true;
    g_last_rx_ms = 0;
    g_stage_ms = 0;
    g_held_thr = 0.f;
    g_stage = FAILSAFE_STAGE_IDLE;
}

void failsafe_note_rx_frame(uint32_t now_ms)
{
    g_never_seen = false;
    g_last_rx_ms = now_ms;
    if (g_stage != FAILSAFE_STAGE_IDLE) {
        /* Link back inside HOLD or PROCEDURE — hand control straight back. */
        failsafe_enter(now_ms, FAILSAFE_STAGE_IDLE);
    }
}

bool failsafe_active(void)
{
    return g_never_seen || g_stage != FAILSAFE_STAGE_IDLE;
}

failsafe_stage_t failsafe_stage(void)
{
    return g_stage;
}

void failsafe_set_action(failsafe_action_t action)
{
    g_action = action;
}

void failsafe_set_hold_ms(uint32_t ms)
{
    g_hold_ms = ms;
}

void failsafe_set_land_ms(uint32_t ms)
{
    g_land_ms = ms;
}

void failsafe_set_land_throttle(float throttle_01)
{
    if (isfinite(throttle_01)) {
        g_land_thr = throttle_01;
        if (g_land_thr < 0.f) {
            g_land_thr = 0.f;
        }
        if (g_land_thr > 1.f) {
            g_land_thr = 1.f;
        }
    }
}

void failsafe_tick(uint32_t now_ms)
{
    if (g_never_seen) {
        /* Boot state: active (arming blocked) until a first frame. */
        return;
    }

    if (g_stage == FAILSAFE_STAGE_IDLE) {
        if ((now_ms - g_last_rx_ms) > FAILSAFE_RX_TIMEOUT_MS) {
            g_held_thr = failsafe_capture_throttle();
            failsafe_enter(now_ms, FAILSAFE_STAGE_HOLD);
        }
    }

    if (g_stage == FAILSAFE_STAGE_HOLD) {
        if ((now_ms - g_stage_ms) >= g_hold_ms) {
            failsafe_enter(now_ms, FAILSAFE_STAGE_PROCEDURE);
            if (g_action == FAILSAFE_ACTION_DROP) {
                arming_disarm();
            }
        }
        return;
    }

    /* FAILSAFE_STAGE_PROCEDURE */
    if (g_action == FAILSAFE_ACTION_LAND &&
        (now_ms - g_stage_ms) >= g_land_ms) {
        arming_disarm();
    }
    /* HOLD rides in PROCEDURE until a frame brings the link back. */
}

bool failsafe_command_override(float sticks[4])
{
    if (!sticks || g_stage == FAILSAFE_STAGE_IDLE) {
        return false;
    }
    sticks[0] = 0.f; /* level attitude: no roll demand */
    sticks[1] = 0.f; /* no pitch demand */
    sticks[2] = 0.f; /* no yaw demand */
    if (g_stage == FAILSAFE_STAGE_PROCEDURE && g_action == FAILSAFE_ACTION_LAND) {
        sticks[3] = g_land_thr;
    } else {
        sticks[3] = g_held_thr;
    }
    return true;
}
