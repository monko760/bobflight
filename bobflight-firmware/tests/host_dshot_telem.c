/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit checks for DShot R0c M1–M4 telem: telem-bit encode when bidir on,
 * synthetic GCR ingest → eRPM/status for motors 0..3, edge-delta assemble,
 * stale/timeout, m1 wrappers. No real TIM; HAL IC stubs + inject helper.
 */
#include "drivers/dshot.h"
#include "drivers/dshot_gcr.h"
#include "drivers/dshot_telem.h"
#include "board/board.h"
#include "hal/hal.h"

#include <stdio.h>
#include <string.h>
#include <math.h>

/* --- stubs for dshot.c link --- */
#include "flight/arming.h"
bool bench_motor_active(void) { return false; }
arm_state_t arming_state(void) { return ARM_DISARMED; }
void arming_disarm(void) {}
const board_t *board_get(void) { return NULL; }
bool board_pins_live(void) { return false; }
bool board_mmio_permitted(void) { return false; }
hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *cfg)
{
    (void)cfg;
    return NULL;
}
bool hal_tim_dma_start_burst(hal_tim_dma_t *t, const uint16_t *words, size_t n)
{
    (void)t;
    (void)words;
    (void)n;
    return false;
}
bool hal_tim_dma_set_bit_rate(uint32_t hz)
{
    return hz == 300000u || hz == 600000u;
}
void hal_gpio_init(hal_pin_t pin, hal_gpio_mode_t mode)
{
    (void)pin;
    (void)mode;
}
void hal_gpio_write(hal_pin_t pin, bool high)
{
    (void)pin;
    (void)high;
}

/* Host time + per-motor IC (mirrors hal_host inject path without full host). */
static uint32_t g_ms;
uint32_t hal_millis(void) { return g_ms; }
void hal_host_advance_ms(uint32_t dt) { g_ms += dt; }

typedef struct {
    uint16_t *buf;
    size_t cap;
    size_t n;
    uint16_t bit_ticks;
    bool armed;
} test_ic_slot_t;

static test_ic_slot_t g_ic[HAL_DSHOT_IC_MOTOR_COUNT];

bool hal_dshot_ic_arm(unsigned motor, uint16_t *edge_buf, size_t cap)
{
    test_ic_slot_t *s;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT || !edge_buf || cap == 0u) {
        return false;
    }
    s = &g_ic[motor];
    s->buf = edge_buf;
    s->cap = cap;
    s->n = 0u;
    s->armed = true;
    if (s->bit_ticks == 0u) {
        s->bit_ticks = 1u;
    }
    return true;
}
void hal_dshot_ic_collect(void)
{
    /* Host unit test: inject_edges already filled armed motor bufs. */
}

size_t hal_dshot_ic_take(unsigned motor)
{
    test_ic_slot_t *s;
    size_t n;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return 0u;
    }
    s = &g_ic[motor];
    if (!s->armed) {
        return 0u;
    }
    s->armed = false;
    n = s->n;
    s->n = 0u;
    return n;
}
void hal_dshot_ic_cancel(unsigned motor)
{
    test_ic_slot_t *s;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return;
    }
    s = &g_ic[motor];
    s->armed = false;
    s->n = 0u;
    s->buf = NULL;
    s->cap = 0u;
}
void hal_dshot_ic_cancel_all(void)
{
    unsigned i;
    for (i = 0u; i < HAL_DSHOT_IC_MOTOR_COUNT; i++) {
        hal_dshot_ic_cancel(i);
    }
}
uint16_t hal_dshot_ic_bit_period_ticks(unsigned motor)
{
    test_ic_slot_t *s;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return 1u;
    }
    s = &g_ic[motor];
    return s->bit_ticks == 0u ? 1u : s->bit_ticks;
}
static void inject_edges(unsigned motor, const uint16_t *d, size_t n,
                         uint16_t bit_ticks)
{
    test_ic_slot_t *s;
    size_t i;
    if (motor >= HAL_DSHOT_IC_MOTOR_COUNT) {
        return;
    }
    s = &g_ic[motor];
    s->bit_ticks = bit_ticks == 0u ? 1u : bit_ticks;
    if (!s->armed || !s->buf) {
        return;
    }
    if (n > s->cap) {
        n = s->cap;
    }
    for (i = 0u; i < n; i++) {
        s->buf[i] = d[i];
    }
    s->n = n;
}

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

static int failf(const char *msg, unsigned motor)
{
    fprintf(stderr, "FAIL: %s (motor %u)\n", msg, motor);
    return 1;
}

static uint32_t wire_for_period(uint16_t period_us)
{
    uint16_t p12 = dshot_gcr_pack_period12(period_us);
    return dshot_gcr_encode_21(dshot_gcr_pack_payload(p12));
}

static size_t wire_to_deltas(uint32_t wire, uint16_t bit_ticks, uint16_t *deltas,
                             size_t cap)
{
    size_t nd = 0u;
    unsigned i;
    unsigned prev_bit = (unsigned)((wire >> 20) & 1u);
    uint16_t run = 1u;
    for (i = 1u; i < 21u; i++) {
        unsigned bit = (unsigned)((wire >> (20u - i)) & 1u);
        if (bit == prev_bit) {
            run++;
        } else {
            if (nd < cap) {
                deltas[nd++] = (uint16_t)(run * bit_ticks);
            }
            run = 1u;
            prev_bit = bit;
        }
    }
    if (nd < cap) {
        deltas[nd++] = (uint16_t)(run * bit_ticks);
    }
    return nd;
}

static int check_telem_bit_encode(void)
{
    uint16_t off = dshot_encode_packet(48u);
    uint16_t on = dshot_encode_packet_ex(48u, true);
    uint16_t value_off = (uint16_t)(off >> 4);
    uint16_t value_on = (uint16_t)(on >> 4);

    if (off != 0x0606u) {
        return fail("telem-off packet regression");
    }
    if ((value_off & 1u) != 0u) {
        return fail("telem bit should be 0 when off");
    }
    if ((value_on & 1u) != 1u) {
        return fail("telem bit should be 1 when requested");
    }
    if ((value_on >> 1) != 48u) {
        return fail("throttle field with telem");
    }
    dshot_bidir_set_enabled(false);
    if (dshot_encode_packet(1048u) != 0x830Bu) {
        return fail("encode_packet telem-off golden");
    }
    return 0;
}

static int check_ingest_erpm_motor(unsigned motor)
{
    uint32_t wire = wire_for_period(600u);
    char tag[64];

    dshot_bidir_set_enabled(true);
    g_ms = 1000u + motor;
    dshot_telem_ingest_gcr21(motor, wire);

    if (dshot_telem_status(motor) != DSHOT_TELEM_OK) {
        return failf("ingest status OK", motor);
    }
    if (dshot_telem_period_us(motor) != 600u) {
        return failf("period_us 600", motor);
    }
    if (dshot_erpm(motor) != 100000u) {
        return failf("erpm 100000", motor);
    }
    if (dshot_telem_age_ms(motor) != 0u) {
        return failf("age at ingest", motor);
    }
    if (motor == 0u) {
        if (dshot_m1_telem_status() != DSHOT_TELEM_OK ||
            dshot_m1_erpm() != 100000u ||
            dshot_m1_telem_period_us() != 600u) {
            return fail("m1 wrappers after motor0 ingest");
        }
    }
    (void)tag;
    return 0;
}

static int check_ingest_all_motors(void)
{
    unsigned m;
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        if (check_ingest_erpm_motor(m) != 0) {
            return 1;
        }
    }
    /* Independence: motor 2 OK while motor 1 CRC fail (fresh bidir; no stale). */
    {
        uint16_t p12 = dshot_gcr_pack_period12(600u);
        uint16_t payload = dshot_gcr_pack_payload(p12);
        uint16_t bad = (uint16_t)(payload ^ 0x0001u);
        uint32_t good = dshot_gcr_encode_21(payload);
        uint32_t badw = dshot_gcr_encode_21(bad);
        dshot_bidir_set_enabled(false);
        dshot_bidir_set_enabled(true);
        g_ms = 2000u;
        dshot_telem_ingest_gcr21(1u, badw);
        dshot_telem_ingest_gcr21(2u, good);
        if (dshot_telem_status(1u) != DSHOT_TELEM_CRC_FAIL) {
            return fail("motor1 CRC_FAIL independent");
        }
        if (dshot_telem_status(2u) != DSHOT_TELEM_OK || dshot_erpm(2u) != 100000u) {
            return fail("motor2 OK independent");
        }
    }
    return 0;
}

static int check_crc_and_invalid(void)
{
    unsigned m;
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        uint16_t p12 = dshot_gcr_pack_period12(600u);
        uint16_t payload = dshot_gcr_pack_payload(p12);
        uint16_t bad = (uint16_t)(payload ^ 0x0001u);
        uint32_t wire = dshot_gcr_encode_21(bad);

        dshot_bidir_set_enabled(true);
        dshot_telem_ingest_gcr21(m, wire);
        if (dshot_telem_status(m) != DSHOT_TELEM_CRC_FAIL) {
            return failf("CRC_FAIL map", m);
        }
        if (dshot_erpm(m) != 0u) {
            return failf("erpm zero on CRC fail", m);
        }

        {
            uint32_t gcr20 = (0x19u << 15) | (0x00u << 10) | (0x12u << 5) | 0x16u;
            uint32_t bits21 = 0u;
            unsigned prev = 0u;
            unsigned i;
            for (i = 0u; i < 20u; i++) {
                unsigned gbit = (unsigned)((gcr20 >> (19u - i)) & 1u);
                if (gbit) {
                    prev ^= 1u;
                }
                bits21 = (bits21 << 1) | (uint32_t)prev;
            }
            dshot_telem_ingest_gcr21(m, bits21 & 0x1FFFFFu);
            if (dshot_telem_status(m) != DSHOT_TELEM_INVALID) {
                return failf("INVALID map", m);
            }
        }
    }
    return 0;
}

static int check_stale_and_timeout(void)
{
    unsigned m;
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        uint32_t wire = wire_for_period(1000u);

        dshot_bidir_set_enabled(true);
        g_ms = 5000u;
        dshot_telem_ingest_gcr21(m, wire);
        if (dshot_telem_status(m) != DSHOT_TELEM_OK) {
            return failf("pre-stale OK", m);
        }
        g_ms = 5000u + DSHOT_TELEM_STALE_MS + 1u;
        if (dshot_telem_status(m) != DSHOT_TELEM_STALE) {
            return failf("age → STALE", m);
        }
        if (dshot_erpm(m) != 0u) {
            return failf("erpm zero when STALE", m);
        }

        dshot_bidir_set_enabled(false);
        dshot_bidir_set_enabled(true);
        dshot_telem_note_timeout(m);
        if (dshot_telem_status(m) != DSHOT_TELEM_TIMEOUT) {
            return failf("TIMEOUT status", m);
        }
    }
    return 0;
}

static int check_edge_assemble_roundtrip(void)
{
    unsigned m;
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        uint32_t wire = wire_for_period(600u);
        uint16_t deltas[32];
        size_t nd;
        const uint16_t bit_ticks = 10u;

        if (((wire >> 20) & 1u) != 0u) {
            return fail("expected GCR start bit 0");
        }
        nd = wire_to_deltas(wire, bit_ticks, deltas, 32u);

        dshot_bidir_set_enabled(true);
        g_ms = 8000u + m;
        if (!dshot_telem_ingest_edge_deltas(m, deltas, nd, bit_ticks)) {
            return failf("edge ingest", m);
        }
        if (dshot_telem_status(m) != DSHOT_TELEM_OK) {
            return failf("edge → OK", m);
        }
        if (dshot_erpm(m) != 100000u) {
            return failf("edge erpm", m);
        }
    }
    return 0;
}

static int check_arm_poll_inject(void)
{
    unsigned m;
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        uint32_t wire = wire_for_period(600u);
        uint16_t deltas[32];
        size_t nd;
        const uint16_t bit_ticks = 8u;

        nd = wire_to_deltas(wire, bit_ticks, deltas, 32u);

        dshot_bidir_set_enabled(true);
        g_ms = 9000u + m;
        dshot_telem_arm_listen(m);
        inject_edges(m, deltas, nd, bit_ticks);
        dshot_telem_poll(m);
        if (dshot_telem_status(m) != DSHOT_TELEM_OK) {
            return failf("arm/poll OK", m);
        }
        if (dshot_erpm(m) != 100000u) {
            return failf("arm/poll erpm", m);
        }
    }

    /* poll_all after arm_listen_all */
    {
        uint32_t wire = wire_for_period(600u);
        uint16_t deltas[32];
        size_t nd;
        const uint16_t bit_ticks = 8u;
        nd = wire_to_deltas(wire, bit_ticks, deltas, 32u);
        dshot_bidir_set_enabled(true);
        g_ms = 10000u;
        dshot_telem_arm_listen_all();
        for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
            inject_edges(m, deltas, nd, bit_ticks);
        }
        dshot_telem_poll_all();
        for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
            if (dshot_telem_status(m) != DSHOT_TELEM_OK || dshot_erpm(m) != 100000u) {
                return failf("arm_all/poll_all", m);
            }
        }
    }

    /* m1 wrapper path still works */
    {
        uint32_t wire = wire_for_period(600u);
        uint16_t deltas[32];
        size_t nd;
        const uint16_t bit_ticks = 8u;
        nd = wire_to_deltas(wire, bit_ticks, deltas, 32u);
        dshot_bidir_set_enabled(true);
        g_ms = 11000u;
        dshot_telem_m1_arm_listen();
        inject_edges(0u, deltas, nd, bit_ticks);
        dshot_telem_m1_poll();
        if (dshot_m1_telem_status() != DSHOT_TELEM_OK || dshot_m1_erpm() != 100000u) {
            return fail("m1 arm/poll wrappers");
        }
    }

    dshot_bidir_set_enabled(false);
    if (dshot_m1_telem_status() != DSHOT_TELEM_NONE) {
        return fail("bidir off → NONE");
    }
    if (dshot_m1_erpm() != 0u) {
        return fail("bidir off erpm 0");
    }
    for (m = 0u; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        if (dshot_telem_status(m) != DSHOT_TELEM_NONE || dshot_erpm(m) != 0u) {
            return failf("bidir off clears motor", m);
        }
    }
    return 0;
}

static int check_oob_motor(void)
{
    dshot_bidir_set_enabled(true);
    if (dshot_telem_status(99u) != DSHOT_TELEM_NONE || dshot_erpm(99u) != 0u) {
        return fail("OOB motor");
    }
    dshot_telem_ingest_gcr21(99u, wire_for_period(600u));
    if (dshot_telem_status(0u) != DSHOT_TELEM_NONE) {
        return fail("OOB ingest must not touch motor0");
    }
    return 0;
}

int main(void)
{
    if (check_telem_bit_encode() != 0) {
        return 1;
    }
    if (check_ingest_all_motors() != 0) {
        return 1;
    }
    if (check_crc_and_invalid() != 0) {
        return 1;
    }
    if (check_stale_and_timeout() != 0) {
        return 1;
    }
    if (check_edge_assemble_roundtrip() != 0) {
        return 1;
    }
    if (check_arm_poll_inject() != 0) {
        return 1;
    }
    if (check_oob_motor() != 0) {
        return 1;
    }
    puts("PASS: DShot R0c M1-M4 telem encode/ingest/status");
    return 0;
}
