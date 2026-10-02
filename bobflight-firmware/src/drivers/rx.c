/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "drivers/rx.h"
#include "drivers/rx_internal.h"
#include "drivers/crsf.h"
#include "flight/failsafe.h"
#include "hal/hal.h"
#include "board/board.h"

#include <string.h>
#include <math.h>

static float g_channels[RX_CHANNEL_COUNT];
static bool g_fresh;
static uint32_t g_last_frame;
static uint32_t g_frames;
static const rx_protocol_t *g_proto;
/* LINK_STATISTICS gate (see rx.h). */
static bool g_stats_seen;
static uint8_t g_stats_lq;
static uint8_t g_stats_rf;
static uint32_t g_stats_ms;
/* Last valid RC frame, accepted or held back by the link gate. */
static bool g_raw_seen;
static uint32_t g_last_raw_frame;

static rx_loss_reason_t link_gate(uint32_t now)
{
    if (!g_stats_seen) return RX_LOSS_NONE; /* absent: frames-only, as before */
    if ((uint32_t)(now - g_stats_ms) > RX_LINK_STATS_STALE_MS) return RX_LOSS_STATS_STALE;
    if (g_stats_lq == 0u) return RX_LOSS_LQ_ZERO;
    if (g_stats_rf == CRSF_RF_PROFILE_4FPS) return RX_LOSS_RF_MODE_LOW; /* fresh only: stale returned above */
    return RX_LOSS_NONE;
}

void rx_init(void)
{
    memset(g_channels, 0, sizeof(g_channels));
    g_fresh = false;
    g_last_frame=0; g_frames=0;
    g_stats_seen=false; g_stats_lq=0; g_stats_rf=0; g_stats_ms=0;
    g_raw_seen=false; g_last_raw_frame=0;
    g_proto = &rx_crsf;
    if (g_proto->init) {
        (void)g_proto->init();
    }
}

void rx_poll(void)
{
    if (g_proto && g_proto->poll) {
        g_proto->poll();
    }
}

const float *rx_channels(void)
{
    return g_channels;
}

bool rx_frame_fresh(void)
{
    return g_fresh && (uint32_t)(hal_millis()-g_last_frame)<=250u;
}

uint32_t rx_frame_age_ms(void)
{
    return g_fresh ? (uint32_t)(hal_millis()-g_last_frame) : UINT32_MAX;
}

/* Shared with crsf stub for writing channels */
void rx_stub_set_channels(const float *ch, unsigned n, bool fresh)
{
    if (!ch) {
        return;
    }
    /* Partial or invalid controls must never reset the receiver-loss timer. */
    if (fresh) {
        if (n != RX_CHANNEL_COUNT) return;
        for (unsigned i=0;i<n;i++) {
            if (!isfinite(ch[i]) || ch[i] < (i==3 ? 0.f : -1.f) || ch[i]>1.f) return;
        }
    }
    if (fresh) {
        const uint32_t now = hal_millis();
        g_raw_seen = true; g_last_raw_frame = now;
        /* Stats say the link is gone: a valid-looking frame (e.g. a receiver
         * repeating held or preset controls) must not refresh anything. */
        if (link_gate(now) != RX_LOSS_NONE) return;
    }
    if (n > RX_CHANNEL_COUNT) {
        n = RX_CHANNEL_COUNT;
    }
    memcpy(g_channels, ch, n * sizeof(float));
    g_fresh = fresh;
    if (fresh) {
        g_last_frame=hal_millis();g_frames++;
        failsafe_note_rx_frame(hal_millis());
    }
}

bool rx_uart_bound(void)
{
    return crsf_uart_bound();
}

const char *rx_protocol_name(void)
{
    const board_t *b = board_get();
    if (g_proto && g_proto->name) {
        return g_proto->name;
    }
    return (b && b->rx_protocol[0]) ? b->rx_protocol : "none";
}

uint32_t rx_frame_count(void){return g_frames;}

void rx_link_note_stats(uint8_t uplink_lq, uint8_t rf_profile)
{
    if (uplink_lq > 100u) return;
    g_stats_seen = true;
    g_stats_lq = uplink_lq;
    g_stats_rf = rf_profile;
    g_stats_ms = hal_millis();
}

bool rx_link_stats_present(void) { return g_stats_seen; }

int rx_link_lq(void)
{
    return (g_stats_seen && link_gate(hal_millis()) != RX_LOSS_STATS_STALE) ? (int)g_stats_lq : -1;
}

rx_loss_reason_t rx_loss_reason(void)
{
    const uint32_t now = hal_millis();
    if (!g_raw_seen || (uint32_t)(now - g_last_raw_frame) > 250u) return RX_LOSS_NO_FRAMES;
    return link_gate(now);
}

const char *rx_loss_reason_name(rx_loss_reason_t reason)
{
    switch (reason) {
    case RX_LOSS_NONE: return "none";
    case RX_LOSS_NO_FRAMES: return "no-frames";
    case RX_LOSS_LQ_ZERO: return "lq-zero";
    case RX_LOSS_STATS_STALE: return "stats-stale";
    case RX_LOSS_RF_MODE_LOW: return "rf-mode-low";
    default: return "no-frames";
    }
}
