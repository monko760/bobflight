/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "flight/failsafe.h"
#include "flight/arming.h"

#define FAILSAFE_TIMEOUT_MS 250u

static bool g_active;
static bool g_seen;
static uint32_t g_last_rx_ms;

void failsafe_init(void)
{
    g_active = true;
    g_seen=false;
    g_last_rx_ms = 0;
}

void failsafe_note_rx_frame(uint32_t now_ms)
{
    g_seen=true;
    g_last_rx_ms = now_ms;
    g_active = false;
}

void failsafe_tick(uint32_t now_ms)
{
    if (!g_seen) {
        /* No RX ever — do not trip until we have seen a frame while armed path exists.
         * Skeleton: inactive unless we had RX then lost it. */
        return;
    }
    if ((now_ms - g_last_rx_ms) > FAILSAFE_TIMEOUT_MS) {
        if (!g_active) {
            g_active = true;
            arming_disarm();
        }
    }
}

bool failsafe_active(void)
{
    return g_active;
}
