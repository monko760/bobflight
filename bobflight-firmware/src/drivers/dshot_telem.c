/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * R0b M1 listen-after-TX telemetry: edge/bit assemble → dshot_gcr → eRPM
 * snapshot. Clean-room; reuses R0a GCR decode. HAL IC is Kakute M1 only.
 */
#include "drivers/dshot_telem.h"
#include "drivers/dshot_gcr.h"
#include "hal/hal.h"

#include <string.h>

#define M1_IC_EDGE_CAP 64u

static bool g_bidir;
static bool g_listen_armed;
static dshot_telem_status_t g_sample_status = DSHOT_TELEM_NONE;
static uint32_t g_erpm;
static uint32_t g_period_us;
static uint32_t g_last_ok_ms;
static bool g_have_ok;
static uint16_t g_edges[M1_IC_EDGE_CAP];

static dshot_telem_status_t map_gcr_status(dshot_gcr_status_t st)
{
    switch (st) {
    case DSHOT_GCR_OK:
        return DSHOT_TELEM_OK;
    case DSHOT_GCR_CRC_FAIL:
        return DSHOT_TELEM_CRC_FAIL;
    case DSHOT_GCR_INVALID_GCR:
        return DSHOT_TELEM_INVALID;
    case DSHOT_GCR_STALE:
        return DSHOT_TELEM_STALE;
    default:
        return DSHOT_TELEM_INVALID;
    }
}

static void store_result(const dshot_gcr_result_t *r)
{
    g_sample_status = map_gcr_status(r->status);
    if (r->status == DSHOT_GCR_OK) {
        g_erpm = r->erpm;
        g_period_us = r->period_us;
        g_last_ok_ms = hal_millis();
        g_have_ok = true;
    } else if (r->status == DSHOT_GCR_STALE) {
        g_erpm = 0u;
        g_period_us = 0u;
        /* Keep last_ok_ms so age helpers still work. */
    } else {
        g_erpm = 0u;
        g_period_us = 0u;
    }
}

void dshot_bidir_set_enabled(bool on)
{
    g_bidir = on;
    if (!on) {
        g_listen_armed = false;
        g_sample_status = DSHOT_TELEM_NONE;
        g_erpm = 0u;
        g_period_us = 0u;
        g_have_ok = false;
        g_last_ok_ms = 0u;
        hal_dshot_m1_ic_cancel();
    }
}

bool dshot_bidir_enabled(void)
{
    return g_bidir;
}

uint32_t dshot_m1_telem_age_ms(void)
{
    uint32_t now;
    if (!g_bidir || !g_have_ok) {
        return 0u;
    }
    now = hal_millis();
    if (now < g_last_ok_ms) {
        return 0u; /* clock wrap: treat as fresh */
    }
    return now - g_last_ok_ms;
}

dshot_telem_status_t dshot_m1_telem_status(void)
{
    if (!g_bidir) {
        return DSHOT_TELEM_NONE;
    }
    if (g_have_ok && dshot_m1_telem_age_ms() > DSHOT_TELEM_STALE_MS) {
        return DSHOT_TELEM_STALE;
    }
    return g_sample_status;
}

uint32_t dshot_m1_erpm(void)
{
    if (dshot_m1_telem_status() != DSHOT_TELEM_OK) {
        return 0u;
    }
    return g_erpm;
}

uint32_t dshot_m1_telem_period_us(void)
{
    if (dshot_m1_telem_status() != DSHOT_TELEM_OK) {
        return 0u;
    }
    return g_period_us;
}

void dshot_telem_m1_ingest_gcr21(uint32_t bits21)
{
    dshot_gcr_result_t r;
    if (!g_bidir) {
        return;
    }
    r = dshot_gcr_decode_21(bits21);
    store_result(&r);
}

void dshot_telem_m1_note_timeout(void)
{
    if (!g_bidir) {
        return;
    }
    g_sample_status = DSHOT_TELEM_TIMEOUT;
    g_erpm = 0u;
    g_period_us = 0u;
}

/*
 * Clean-room edge→bit assemble (public BDShot shape):
 * consecutive capture deltas are run-lengths of the current wire level.
 * Round each delta to an integer number of telem bit periods; append that
 * many bits, then flip the level. Collect the low 21 bits MSB-first.
 */
bool dshot_telem_m1_ingest_edge_deltas(const uint16_t *deltas, size_t n,
                                       uint16_t bit_period_ticks)
{
    uint32_t bits21 = 0u;
    unsigned got = 0u;
    unsigned level = 0u; /* wire idle-low assumption after TX release */
    size_t i;

    if (!g_bidir) {
        return false;
    }
    if (!deltas || n == 0u || bit_period_ticks == 0u) {
        dshot_telem_m1_note_timeout();
        return false;
    }

    for (i = 0u; i < n && got < 21u; i++) {
        uint32_t d = deltas[i];
        uint32_t nb = (d + (uint32_t)bit_period_ticks / 2u) / (uint32_t)bit_period_ticks;
        unsigned b;
        if (nb == 0u) {
            nb = 1u;
        }
        for (b = 0u; b < nb && got < 21u; b++) {
            bits21 = (bits21 << 1) | (uint32_t)(level & 1u);
            got++;
        }
        level ^= 1u;
    }

    if (got < 21u) {
        dshot_telem_m1_note_timeout();
        return false;
    }

    dshot_telem_m1_ingest_gcr21(bits21 & 0x1FFFFFu);
    return true;
}

void dshot_telem_m1_arm_listen(void)
{
    if (!g_bidir) {
        return;
    }
    memset(g_edges, 0, sizeof(g_edges));
    if (!hal_dshot_m1_ic_arm(g_edges, M1_IC_EDGE_CAP)) {
        dshot_telem_m1_note_timeout();
        g_listen_armed = false;
        return;
    }
    g_listen_armed = true;
}

void dshot_telem_m1_poll(void)
{
    size_t n;
    uint16_t bit_ticks;

    if (!g_bidir || !g_listen_armed) {
        return;
    }
    n = hal_dshot_m1_ic_take();
    g_listen_armed = false;
    if (n < 2u) {
        dshot_telem_m1_note_timeout();
        return;
    }
    bit_ticks = hal_dshot_m1_ic_bit_period_ticks();
    if (bit_ticks == 0u) {
        dshot_telem_m1_note_timeout();
        return;
    }
    (void)dshot_telem_m1_ingest_edge_deltas(g_edges, n, bit_ticks);
}
