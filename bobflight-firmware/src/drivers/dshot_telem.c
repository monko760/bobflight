/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * R0c M1–M4 listen-after-TX telemetry: edge/bit assemble → dshot_gcr → eRPM
 * snapshot. Clean-room; reuses R0a GCR decode. HAL IC is Kakute M1–M4.
 * poll_all uses parallel IC collect (listen-window sharpen vs sequential take).
 */
#include "drivers/dshot_telem.h"
#include "drivers/dshot_gcr.h"
#include "hal/hal.h"

#include <string.h>

#define IC_EDGE_CAP 64u

typedef struct {
    bool listen_armed;
    dshot_telem_status_t sample_status;
    uint32_t erpm;
    uint32_t period_us;
    uint32_t last_ok_ms;
    bool have_ok;
    uint16_t edges[IC_EDGE_CAP];
} dshot_telem_slot_t;

static bool g_bidir;
static dshot_telem_slot_t g_slot[DSHOT_TELEM_MOTOR_COUNT];

static bool motor_ok(unsigned motor)
{
    return motor < DSHOT_TELEM_MOTOR_COUNT;
}

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

static void store_result(dshot_telem_slot_t *s, const dshot_gcr_result_t *r)
{
    s->sample_status = map_gcr_status(r->status);
    if (r->status == DSHOT_GCR_OK) {
        s->erpm = r->erpm;
        s->period_us = r->period_us;
        s->last_ok_ms = hal_millis();
        s->have_ok = true;
    } else if (r->status == DSHOT_GCR_STALE) {
        s->erpm = 0u;
        s->period_us = 0u;
        /* Keep last_ok_ms so age helpers still work. */
    } else {
        s->erpm = 0u;
        s->period_us = 0u;
    }
}

static void clear_slot(dshot_telem_slot_t *s)
{
    s->listen_armed = false;
    s->sample_status = DSHOT_TELEM_NONE;
    s->erpm = 0u;
    s->period_us = 0u;
    s->have_ok = false;
    s->last_ok_ms = 0u;
}

void dshot_bidir_set_enabled(bool on)
{
    unsigned m;
    g_bidir = on;
    if (!on) {
        for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
            clear_slot(&g_slot[m]);
        }
        hal_dshot_ic_cancel_all();
    }
}

bool dshot_bidir_enabled(void)
{
    return g_bidir;
}

uint32_t dshot_telem_age_ms(unsigned motor)
{
    dshot_telem_slot_t *s;
    uint32_t now;
    if (!g_bidir || !motor_ok(motor)) {
        return 0u;
    }
    s = &g_slot[motor];
    if (!s->have_ok) {
        return 0u;
    }
    now = hal_millis();
    if (now < s->last_ok_ms) {
        return 0u; /* clock wrap: treat as fresh */
    }
    return now - s->last_ok_ms;
}

dshot_telem_status_t dshot_telem_status(unsigned motor)
{
    dshot_telem_slot_t *s;
    if (!g_bidir || !motor_ok(motor)) {
        return DSHOT_TELEM_NONE;
    }
    s = &g_slot[motor];
    if (s->have_ok && dshot_telem_age_ms(motor) > DSHOT_TELEM_STALE_MS) {
        return DSHOT_TELEM_STALE;
    }
    return s->sample_status;
}

uint32_t dshot_erpm(unsigned motor)
{
    if (dshot_telem_status(motor) != DSHOT_TELEM_OK) {
        return 0u;
    }
    return g_slot[motor].erpm;
}

uint32_t dshot_telem_period_us(unsigned motor)
{
    if (dshot_telem_status(motor) != DSHOT_TELEM_OK) {
        return 0u;
    }
    return g_slot[motor].period_us;
}

void dshot_telem_ingest_gcr21(unsigned motor, uint32_t bits21)
{
    dshot_gcr_result_t r;
    if (!g_bidir || !motor_ok(motor)) {
        return;
    }
    r = dshot_gcr_decode_21(bits21);
    store_result(&g_slot[motor], &r);
}

void dshot_telem_note_timeout(unsigned motor)
{
    dshot_telem_slot_t *s;
    if (!g_bidir || !motor_ok(motor)) {
        return;
    }
    s = &g_slot[motor];
    s->sample_status = DSHOT_TELEM_TIMEOUT;
    s->erpm = 0u;
    s->period_us = 0u;
}

/*
 * Clean-room edge→bit assemble (public BDShot shape):
 * consecutive capture deltas are run-lengths of the current wire level.
 * Round each delta to an integer number of telem bit periods; append that
 * many bits, then flip the level. Collect the low 21 bits MSB-first.
 */
bool dshot_telem_ingest_edge_deltas(unsigned motor, const uint16_t *deltas,
                                    size_t n, uint16_t bit_period_ticks)
{
    uint32_t bits21 = 0u;
    unsigned got = 0u;
    unsigned level = 0u; /* wire idle-low assumption after TX release */
    size_t i;

    if (!g_bidir || !motor_ok(motor)) {
        return false;
    }
    if (!deltas || n == 0u || bit_period_ticks == 0u) {
        dshot_telem_note_timeout(motor);
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
        dshot_telem_note_timeout(motor);
        return false;
    }

    dshot_telem_ingest_gcr21(motor, bits21 & 0x1FFFFFu);
    return true;
}

void dshot_telem_arm_listen(unsigned motor)
{
    dshot_telem_slot_t *s;
    if (!g_bidir || !motor_ok(motor)) {
        return;
    }
    s = &g_slot[motor];
    memset(s->edges, 0, sizeof(s->edges));
    if (!hal_dshot_ic_arm(motor, s->edges, IC_EDGE_CAP)) {
        dshot_telem_note_timeout(motor);
        s->listen_armed = false;
        return;
    }
    s->listen_armed = true;
}

void dshot_telem_arm_listen_all(void)
{
    unsigned m;
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        dshot_telem_arm_listen(m);
    }
}

void dshot_telem_poll(unsigned motor)
{
    dshot_telem_slot_t *s;
    size_t n;
    uint16_t bit_ticks;

    if (!g_bidir || !motor_ok(motor)) {
        return;
    }
    s = &g_slot[motor];
    if (!s->listen_armed) {
        return;
    }
    n = hal_dshot_ic_take(motor);
    s->listen_armed = false;
    if (n < 2u) {
        dshot_telem_note_timeout(motor);
        return;
    }
    bit_ticks = hal_dshot_ic_bit_period_ticks(motor);
    if (bit_ticks == 0u) {
        dshot_telem_note_timeout(motor);
        return;
    }
    (void)dshot_telem_ingest_edge_deltas(motor, s->edges, n, bit_ticks);
}

void dshot_telem_poll_all(void)
{
    unsigned m;
    /* One parallel IC collect so M1–M4 share the listen window (R0c sharpen). */
    hal_dshot_ic_collect();
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        dshot_telem_poll(m);
    }
}
