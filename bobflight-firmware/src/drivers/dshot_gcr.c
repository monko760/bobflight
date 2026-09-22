/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Clean-room bidirectional DShot GCR decode → eRPM (R0a, host-testable).
 * Protocol constants from public BDShot / Betaflight DSHOT wiki descriptions
 * and Brushless Whoop handbook — independent implementation, no GPL import.
 */
#include "drivers/dshot_gcr.h"

/* Public 4→5 GCR map (nibble index → 5-bit code). */
static const uint8_t k_nibble_to_gcr[16] = {
    0x19u, 0x1Bu, 0x12u, 0x13u,
    0x1Du, 0x15u, 0x16u, 0x17u,
    0x1Au, 0x09u, 0x0Au, 0x0Bu,
    0x1Eu, 0x0Du, 0x0Eu, 0x0Fu
};

/* Inverse map: 5-bit code → nibble, 0xFF = invalid. */
static const uint8_t k_gcr_to_nibble[32] = {
    0xFFu, 0xFFu, 0xFFu, 0xFFu, 0xFFu, 0xFFu, 0xFFu, 0xFFu, /* 00..07 */
    0xFFu, 0x09u, 0x0Au, 0x0Bu, 0xFFu, 0x0Du, 0x0Eu, 0x0Fu, /* 08..0F */
    0xFFu, 0xFFu, 0x02u, 0x03u, 0xFFu, 0x05u, 0x06u, 0x07u, /* 10..17 */
    0xFFu, 0x00u, 0x08u, 0x01u, 0xFFu, 0x04u, 0x0Cu, 0xFFu  /* 18..1F */
};

uint8_t dshot_gcr_encode_nibble(uint8_t nibble)
{
    return k_nibble_to_gcr[nibble & 0x0Fu];
}

bool dshot_gcr_decode_nibble(uint8_t gcr5, uint8_t *out_nibble)
{
    uint8_t n;
    if (!out_nibble) {
        return false;
    }
    n = k_gcr_to_nibble[gcr5 & 0x1Fu];
    if (n == 0xFFu) {
        return false;
    }
    *out_nibble = n;
    return true;
}

uint16_t dshot_gcr_pack_payload(uint16_t period12)
{
    uint16_t p = (uint16_t)(period12 & 0x0FFFu);
    uint8_t crc = (uint8_t)((~(p ^ (p >> 4) ^ (p >> 8))) & 0x0Fu);
    return (uint16_t)((p << 4) | crc);
}

uint16_t dshot_gcr_pack_period12(uint32_t period_us)
{
    uint32_t e = 0u;
    uint32_t m = period_us;
    while (m > 0x1FFu && e < 7u) {
        m >>= 1u;
        e++;
    }
    if (m > 0x1FFu) {
        m = 0x1FFu;
    }
    return (uint16_t)(((e & 7u) << 9) | (m & 0x1FFu));
}

uint32_t dshot_gcr_period12_to_us(uint16_t period12)
{
    uint16_t p = (uint16_t)(period12 & 0x0FFFu);
    uint32_t m = (uint32_t)(p & 0x1FFu);
    uint32_t e = (uint32_t)((p >> 9) & 7u);
    return m << e;
}

uint32_t dshot_gcr_period_us_to_erpm(uint32_t period_us)
{
    if (period_us == 0u) {
        return 0u;
    }
    return 60000000u / period_us;
}

bool dshot_gcr_age_is_stale(uint32_t age_us, uint32_t threshold_us)
{
    if (threshold_us == 0u) {
        return false;
    }
    return age_us > threshold_us;
}

/*
 * Encode 16-bit payload → 21-bit differential GCR word.
 * Wire format: start bit 0, then 20 differentially coded bits derived from
 * the 20-bit nibble-mapped GCR value (public BDShot rule).
 */
uint32_t dshot_gcr_encode_21(uint16_t payload16)
{
    uint32_t gcr20 = 0u;
    uint32_t bits21 = 0u;
    unsigned i;
    unsigned prev = 0u;

    for (i = 0u; i < 4u; i++) {
        uint8_t nib = (uint8_t)((payload16 >> (12u - 4u * i)) & 0x0Fu);
        gcr20 = (gcr20 << 5) | (uint32_t)dshot_gcr_encode_nibble(nib);
    }
    gcr20 &= 0xFFFFFu;

    /* bits21 accumulates start(0) + 20 transformed bits. */
    bits21 = 0u; /* start bit */
    for (i = 0u; i < 20u; i++) {
        unsigned gbit = (unsigned)((gcr20 >> (19u - i)) & 1u);
        if (gbit) {
            prev ^= 1u;
        }
        bits21 = (bits21 << 1) | (uint32_t)prev;
    }
    return bits21 & 0x1FFFFFu;
}

static bool payload_crc_ok(uint16_t payload16)
{
    unsigned n0 = (payload16 >> 0) & 0xFu;
    unsigned n1 = (payload16 >> 4) & 0xFu;
    unsigned n2 = (payload16 >> 8) & 0xFu;
    unsigned n3 = (payload16 >> 12) & 0xFu;
    return ((n0 ^ n1 ^ n2 ^ n3) & 0xFu) == 0xFu;
}

dshot_gcr_result_t dshot_gcr_decode_21(uint32_t bits21)
{
    dshot_gcr_result_t r;
    uint32_t v = bits21 & 0x1FFFFFu;
    uint32_t gcr20;
    uint16_t payload = 0u;
    unsigned i;

    r.status = DSHOT_GCR_INVALID_GCR;
    r.payload16 = 0u;
    r.period12 = 0u;
    r.period_us = 0u;
    r.erpm = 0u;

    /* Differential undo: GCR bit = wire_bit XOR previous_wire_bit.
     * Public shortcut: gcr = v ^ (v >> 1); keep lower 20 bits. */
    gcr20 = (v ^ (v >> 1)) & 0xFFFFFu;

    for (i = 0u; i < 4u; i++) {
        uint8_t sym = (uint8_t)((gcr20 >> (15u - 5u * i)) & 0x1Fu);
        uint8_t nib;
        if (!dshot_gcr_decode_nibble(sym, &nib)) {
            return r;
        }
        payload = (uint16_t)((payload << 4) | nib);
    }

    r.payload16 = payload;
    if (!payload_crc_ok(payload)) {
        r.status = DSHOT_GCR_CRC_FAIL;
        return r;
    }

    r.period12 = (uint16_t)(payload >> 4);
    r.period_us = dshot_gcr_period12_to_us(r.period12);
    if (r.period_us == 0u) {
        r.status = DSHOT_GCR_STALE;
        r.erpm = 0u;
        return r;
    }

    r.erpm = dshot_gcr_period_us_to_erpm(r.period_us);
    r.status = DSHOT_GCR_OK;
    return r;
}
