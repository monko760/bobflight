/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "drivers/rx.h"
#include "drivers/rx_internal.h"
#include "flight/failsafe.h"
#include "hal/hal.h"
#include "board/board.h"

#include <string.h>

static float g_channels[RX_CHANNEL_COUNT];
static bool g_fresh;
static uint32_t g_last_frame;
static uint32_t g_frames;
static const rx_protocol_t *g_proto;

void rx_init(void)
{
    memset(g_channels, 0, sizeof(g_channels));
    g_fresh = false;
    g_last_frame=0; g_frames=0;
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

/* Shared with crsf stub for writing channels */
void rx_stub_set_channels(const float *ch, unsigned n, bool fresh)
{
    if (!ch) {
        return;
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
