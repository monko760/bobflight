/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit checks for clean-room bidirectional DShot GCR → eRPM decode.
 * Vectors are independently generated (encode helpers in dshot_gcr.c);
 * not copied from Betaflight or other GPL trees.
 */
#include "drivers/dshot_gcr.h"

#include <stdio.h>
#include <stdint.h>

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

static int check_nibble_roundtrip(void)
{
    unsigned n;
    for (n = 0u; n < 16u; n++) {
        uint8_t gcr = dshot_gcr_encode_nibble((uint8_t)n);
        uint8_t back = 0xFFu;
        if (!dshot_gcr_decode_nibble(gcr, &back)) {
            return fail("nibble decode rejected valid GCR");
        }
        if (back != (uint8_t)n) {
            return fail("nibble round-trip mismatch");
        }
    }
    /* Known invalid 5-bit codes (not in the public map). */
    {
        uint8_t junk = 0;
        if (dshot_gcr_decode_nibble(0x00u, &junk)) {
            return fail("0x00 should be INVALID_GCR");
        }
        if (dshot_gcr_decode_nibble(0x1Fu, &junk)) {
            return fail("0x1F should be INVALID_GCR");
        }
        if (dshot_gcr_decode_nibble(0x11u, &junk)) {
            return fail("0x11 should be INVALID_GCR");
        }
    }
    return 0;
}

static int check_period_roundtrip(uint32_t want_period_us, uint32_t want_erpm)
{
    uint16_t p12 = dshot_gcr_pack_period12(want_period_us);
    uint16_t payload = dshot_gcr_pack_payload(p12);
    uint32_t wire = dshot_gcr_encode_21(payload);
    dshot_gcr_result_t r = dshot_gcr_decode_21(wire);
    char buf[96];

    if (r.status != DSHOT_GCR_OK) {
        snprintf(buf, sizeof(buf), "period %u decode status %d",
                 (unsigned)want_period_us, (int)r.status);
        return fail(buf);
    }
    if (r.period_us != want_period_us) {
        snprintf(buf, sizeof(buf), "period %u got period_us %u",
                 (unsigned)want_period_us, (unsigned)r.period_us);
        return fail(buf);
    }
    if (r.erpm != want_erpm) {
        snprintf(buf, sizeof(buf), "period %u erpm want %u got %u",
                 (unsigned)want_period_us, (unsigned)want_erpm, (unsigned)r.erpm);
        return fail(buf);
    }
    return 0;
}

static int check_crc_fail(void)
{
    uint16_t p12 = dshot_gcr_pack_period12(600u);
    uint16_t payload = dshot_gcr_pack_payload(p12);
    uint16_t bad = (uint16_t)(payload ^ 0x0001u); /* flip CRC LSB */
    uint32_t wire = dshot_gcr_encode_21(bad);
    dshot_gcr_result_t r = dshot_gcr_decode_21(wire);
    if (r.status != DSHOT_GCR_CRC_FAIL) {
        return fail("expected CRC_FAIL");
    }
    return 0;
}

static int check_invalid_gcr_frame(void)
{
    /* Craft 20-bit GCR with an illegal 5-bit symbol (0x00), then
     * differentially encode to 21 bits the same way as encode_21. */
    uint32_t gcr20 = (0x19u << 15) | (0x00u << 10) | (0x12u << 5) | 0x16u;
    uint32_t bits21 = 0u;
    unsigned prev = 0u;
    unsigned i;
    dshot_gcr_result_t r;

    for (i = 0u; i < 20u; i++) {
        unsigned gbit = (unsigned)((gcr20 >> (19u - i)) & 1u);
        if (gbit) {
            prev ^= 1u;
        }
        bits21 = (bits21 << 1) | (uint32_t)prev;
    }
    r = dshot_gcr_decode_21(bits21);
    if (r.status != DSHOT_GCR_INVALID_GCR) {
        return fail("expected INVALID_GCR");
    }
    return 0;
}

static int check_stale_zero_period(void)
{
    uint16_t payload = dshot_gcr_pack_payload(0u); /* period12 = 0 */
    uint32_t wire = dshot_gcr_encode_21(payload);
    dshot_gcr_result_t r = dshot_gcr_decode_21(wire);
    if (r.status != DSHOT_GCR_STALE) {
        return fail("zero period should be STALE");
    }
    if (r.erpm != 0u || r.period_us != 0u) {
        return fail("stale should zero erpm/period_us");
    }
    if (!dshot_gcr_age_is_stale(2000u, 1000u)) {
        return fail("age helper should flag stale");
    }
    if (dshot_gcr_age_is_stale(500u, 1000u)) {
        return fail("age helper false positive");
    }
    if (dshot_gcr_age_is_stale(99999u, 0u)) {
        return fail("threshold 0 means never age-stale");
    }
    return 0;
}

int main(void)
{
    if (check_nibble_roundtrip() != 0) {
        return 1;
    }

    /* Periods that pack losslessly into eee_mmmmmmmmm. */
    if (check_period_roundtrip(100u, 600000u) != 0) {   /* m=100,e=0 */
        return 1;
    }
    if (check_period_roundtrip(600u, 100000u) != 0) {   /* m=300,e=1 */
        return 1;
    }
    if (check_period_roundtrip(1000u, 60000u) != 0) {   /* m=500,e=1 */
        return 1;
    }
    if (check_period_roundtrip(2048u, 29296u) != 0) {   /* m=256,e=3 → 60000000/2048 */
        return 1;
    }

    if (check_crc_fail() != 0) {
        return 1;
    }
    if (check_invalid_gcr_frame() != 0) {
        return 1;
    }
    if (check_stale_zero_period() != 0) {
        return 1;
    }

    puts("PASS: DShot GCR nibble/frame/eRPM decode");
    return 0;
}
