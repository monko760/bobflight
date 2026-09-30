/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * M1–M4 bidirectional DShot telemetry: capture timestamps → edge/bit
 * assemble → dshot_gcr → eRPM snapshot. Clean-room; reuses R0a GCR decode.
 *
 * B2 (4 kHz): the receive path is NON-BLOCKING and pipelined across loop
 * iterations. Per cycle, dshot_write() calls
 *   1. dshot_telem_poll_all()        harvest + decode the reply to the
 *                                    PREVIOUS frame (captured by DMA while
 *                                    the CPU ran the gyro slot),
 *   2. dshot_telem_arm_listen_all()  register buffers for THIS frame,
 *   3. the TX bursts                 the TX DMA TC IRQ opens the window.
 * Nothing waits for the frame or the reply. A cycle whose capture itself
 * failed (window never opened, DMA error, or reply cut off by the harvest)
 * counts toward DSHOT_TELEM_CAPTURE_FAIL_LIMIT consecutive cycles, which
 * latches dshot_telem_capture_failed(); the loop-rate policy then falls back
 * to 1000/1 (reason dshot-bidir-capture-failed). A silent ESC is only
 * TIMEOUT, never a capture failure (USB-only bench: ESCs unpowered).
 */
#include "drivers/dshot_telem.h"
#include "drivers/dshot_gcr.h"
#include "hal/hal.h"

#include <string.h>

#define IC_EDGE_CAP DSHOT_TELEM_EDGE_CAP

typedef enum {
    CAPTURE_NONE = 0,   /* nothing harvested yet */
    CAPTURE_FRAME,      /* 21 bits assembled (status from GCR decode) */
    CAPTURE_SILENT,     /* window ran, no edge train (ESC silent) */
    CAPTURE_TRUNCATED,  /* reply started but was cut off by the harvest */
    CAPTURE_GLITCH,     /* sub-half-bit run: noise → INVALID */
    CAPTURE_FAULT       /* HAL: window never opened / DMA error / no HW */
} capture_outcome_t;

typedef struct {
    bool listen_armed;
    capture_outcome_t outcome;
    dshot_telem_status_t sample_status;
    uint32_t erpm;
    uint32_t period_us;
    uint32_t last_ok_ms;
    bool have_ok;
    uint16_t edges[IC_EDGE_CAP];
} dshot_telem_slot_t;

static bool g_bidir;
static dshot_telem_slot_t g_slot[DSHOT_TELEM_MOTOR_COUNT];
static uint32_t g_fail_streak;
static bool g_capture_failed;
static uint32_t g_cycles;

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
    s->outcome = CAPTURE_NONE;
    s->sample_status = DSHOT_TELEM_NONE;
    s->erpm = 0u;
    s->period_us = 0u;
    s->have_ok = false;
    s->last_ok_ms = 0u;
}

void dshot_bidir_set_enabled(bool on)
{
    unsigned m;
    if (on != g_bidir || !on) {
        /* Any enable/disable edge restarts the capture-failure latch. */
        for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
            clear_slot(&g_slot[m]);
        }
        hal_dshot_ic_cancel_all();
        g_fail_streak = 0u;
        g_capture_failed = false;
        g_cycles = 0u;
    }
    g_bidir = on;
    /* BDShot: inverted line (idle high) tells the ESC to answer on the wire. */
    hal_tim_dma_set_inverted(on);
}

bool dshot_telem_capture_failed(void)
{
    return g_bidir && g_capture_failed;
}

uint32_t dshot_telem_capture_fail_streak(void)
{
    return g_bidir ? g_fail_streak : 0u;
}

uint32_t dshot_telem_cycles(void)
{
    return g_bidir ? g_cycles : 0u;
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
 * many bits, then flip the level. Collect 21 bits MSB-first. The absolute
 * level does not matter: GCR is transition coded (bits ^ bits>>1).
 *
 * B2 hardening:
 *  - a run shorter than half a bit is noise → INVALID (never a made-up bit);
 *  - leading runs longer than DSHOT_TELEM_MAX_RUN_BITS + 1 before any frame
 *    bit are pre-frame idle (TX tail / switch glitch) and are skipped;
 *  - the final run has no terminating edge when the reply ends at the idle
 *    level. The frame is exactly 21 bits, so when the line has been quiet
 *    for > DSHOT_TELEM_MAX_RUN_BITS bit periods (tail_ticks) and at most
 *    DSHOT_TELEM_MAX_RUN_BITS bits are missing, the remainder is that run.
 *    Otherwise (line still active at harvest, or more bits missing) the
 *    reply was truncated.
 */
static capture_outcome_t assemble(const uint16_t *deltas, size_t n,
                                  uint16_t bit_period_ticks, uint16_t tail_ticks,
                                  uint32_t *out_bits21)
{
    uint32_t bits21 = 0u;
    unsigned got = 0u;
    unsigned level = 0u;
    size_t i;

    for (i = 0u; i < n && got < 21u; i++) {
        uint32_t d = deltas[i];
        uint32_t nb = (d + (uint32_t)bit_period_ticks / 2u) / (uint32_t)bit_period_ticks;
        unsigned b;
        if (nb == 0u) {
            return CAPTURE_GLITCH;
        }
        if (got == 0u && nb > DSHOT_TELEM_MAX_RUN_BITS + 1u) {
            continue; /* pre-frame idle: the next edge starts the frame */
        }
        for (b = 0u; b < nb && got < 21u; b++) {
            bits21 = (bits21 << 1) | (uint32_t)(level & 1u);
            got++;
        }
        level ^= 1u;
    }

    if (got < 21u) {
        const unsigned missing = 21u - got;
        const uint32_t quiet_need = (uint32_t)bit_period_ticks * (DSHOT_TELEM_MAX_RUN_BITS + 1u);
        if (got == 0u) {
            return CAPTURE_SILENT;
        }
        if (missing > DSHOT_TELEM_MAX_RUN_BITS || (uint32_t)tail_ticks < quiet_need) {
            return CAPTURE_TRUNCATED;
        }
        while (got < 21u) {
            bits21 = (bits21 << 1) | (uint32_t)(level & 1u);
            got++;
        }
    }
    *out_bits21 = bits21 & 0x1FFFFFu;
    return CAPTURE_FRAME;
}

static bool ingest_deltas_ex(unsigned motor, const uint16_t *deltas, size_t n,
                             uint16_t bit_period_ticks, uint16_t tail_ticks)
{
    uint32_t bits21 = 0u;
    capture_outcome_t o;
    dshot_telem_slot_t *s;

    if (!g_bidir || !motor_ok(motor)) {
        return false;
    }
    s = &g_slot[motor];
    if (!deltas || n == 0u || bit_period_ticks == 0u) {
        s->outcome = CAPTURE_SILENT;
        dshot_telem_note_timeout(motor);
        return false;
    }
    o = assemble(deltas, n, bit_period_ticks, tail_ticks, &bits21);
    s->outcome = o;
    if (o == CAPTURE_GLITCH) {
        s->sample_status = DSHOT_TELEM_INVALID;
        s->erpm = 0u;
        s->period_us = 0u;
        return false;
    }
    if (o != CAPTURE_FRAME) {
        dshot_telem_note_timeout(motor); /* no complete frame in the window */
        return false;
    }
    dshot_telem_ingest_gcr21(motor, bits21);
    return true;
}

bool dshot_telem_ingest_edge_deltas(unsigned motor, const uint16_t *deltas,
                                    size_t n, uint16_t bit_period_ticks)
{
    /* Delta API (R0c callers/tests): the caller owns framing; treat the
     * line as quiet after the last delta. */
    return ingest_deltas_ex(motor, deltas, n, bit_period_ticks, HAL_DSHOT_IC_TAIL_QUIET);
}

bool dshot_telem_ingest_capture(unsigned motor, const uint16_t *ts, size_t n,
                                uint16_t bit_period_ticks, uint16_t tail_ticks)
{
    uint16_t deltas[DSHOT_TELEM_EDGE_CAP];
    size_t i;
    size_t nd = 0u;

    if (!g_bidir || !motor_ok(motor)) {
        return false;
    }
    if (!ts || n < 2u) {
        g_slot[motor].outcome = CAPTURE_SILENT;
        dshot_telem_note_timeout(motor);
        return false;
    }
    if (n > DSHOT_TELEM_EDGE_CAP) {
        n = DSHOT_TELEM_EDGE_CAP;
    }
    for (i = 1u; i < n; i++) {
        /* 16-bit timer: modular difference is the run length. */
        deltas[nd++] = (uint16_t)((uint32_t)ts[i] - (uint32_t)ts[i - 1u]);
    }
    return ingest_deltas_ex(motor, deltas, nd, bit_period_ticks, tail_ticks);
}

void dshot_telem_arm_listen(unsigned motor)
{
    dshot_telem_slot_t *s;
    if (!g_bidir || !motor_ok(motor)) {
        return;
    }
    s = &g_slot[motor];
    memset(s->edges, 0, sizeof(s->edges));
    /* Non-blocking: only registers the buffer; the TX DMA TC IRQ opens the
     * capture window after this cycle's frame. */
    if (!hal_dshot_ic_arm(motor, s->edges, IC_EDGE_CAP)) {
        dshot_telem_note_timeout(motor);
        s->outcome = CAPTURE_FAULT;
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
    hal_dshot_ic_result_t res;

    if (!g_bidir || !motor_ok(motor)) {
        return;
    }
    s = &g_slot[motor];
    if (!s->listen_armed) {
        return;
    }
    n = hal_dshot_ic_take(motor); /* non-blocking; harvests the group if needed */
    res = hal_dshot_ic_result(motor);
    s->listen_armed = false;
    if (res != HAL_DSHOT_IC_OK) {
        s->outcome = CAPTURE_FAULT;
        dshot_telem_note_timeout(motor);
        return;
    }
    bit_ticks = hal_dshot_ic_bit_period_ticks(motor);
    if (bit_ticks == 0u) {
        s->outcome = CAPTURE_FAULT;
        dshot_telem_note_timeout(motor);
        return;
    }
    (void)dshot_telem_ingest_capture(motor, s->edges, n, bit_ticks,
                                     hal_dshot_ic_tail_ticks(motor));
}

void dshot_telem_poll_all(void)
{
    unsigned m;
    bool any = false;
    bool fault = false;

    if (!g_bidir) {
        return;
    }
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        if (g_slot[m].listen_armed || g_slot[m].outcome == CAPTURE_FAULT) {
            any = true;
        }
    }
    if (!any) {
        return; /* first cycle after enable: nothing to harvest yet */
    }
    /* One non-blocking harvest for both timer groups (no spin, no wait). */
    hal_dshot_ic_collect();
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        dshot_telem_slot_t *s = &g_slot[m];
        dshot_telem_poll(m);
        if (s->outcome == CAPTURE_FAULT || s->outcome == CAPTURE_TRUNCATED) {
            fault = true;
        }
    }
    g_cycles++;
    if (fault) {
        if (g_fail_streak < UINT32_MAX) {
            g_fail_streak++;
        }
        if (g_fail_streak >= DSHOT_TELEM_CAPTURE_FAIL_LIMIT) {
            g_capture_failed = true; /* latched until bidir off/on */
        }
    } else {
        g_fail_streak = 0u;
    }
}
