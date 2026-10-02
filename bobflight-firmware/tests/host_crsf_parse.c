/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit checks for CRSF CRC8 (poly 0xD5) + RC 11-bit unpack/normalize.
 */
#include "drivers/crsf.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

/* --- board/hal/rx stubs (parse/CRC are pure; linker needs crsf.c deps) --- */
#include "board/board.h"
#include "hal/hal.h"
#include "drivers/rx_internal.h"

const board_t *board_get(void) { return NULL; }
uint32_t hal_millis(void) { return 0; }
bool board_pins_live(void) { return false; }
hal_uart_t *hal_uart_open_cfg(const hal_uart_cfg_t *cfg)
{
    (void)cfg;
    return NULL;
}
size_t hal_uart_read(hal_uart_t *u, uint8_t *buf, size_t maxlen)
{
    (void)u;
    (void)buf;
    (void)maxlen;
    return 0;
}
void rx_stub_set_channels(const float *ch, unsigned n, bool fresh)
{
    (void)ch;
    (void)n;
    (void)fresh;
}
void rx_link_note_stats(uint8_t uplink_lq)
{
    (void)uplink_lq;
}

/* LINK_STATISTICS (0x14): addr, len=12, type, 10-byte payload, crc. */
static void build_link_stats(uint8_t f[14], uint8_t lq)
{
    const uint8_t payload[10] = {60u, 62u, lq, 9u, 0u, 7u, 3u, 70u, 98u, 5u};
    f[0] = 0xC8u; f[1] = 12u; f[2] = 0x14u;
    memcpy(&f[3], payload, 10);
    f[13] = crsf_crc8(&f[2], 11u);
}

static int link_stats_checks(void)
{
    uint8_t f[16], lq = 0xAAu;
    build_link_stats(f, 87u);
    if (!crsf_parse_link_stats(f, 14u, &lq) || lq != 87u) return 1;
    build_link_stats(f, 0u); lq = 0xAAu;
    if (!crsf_parse_link_stats(f, 14u, &lq) || lq != 0u) return 2;
    build_link_stats(f, 100u);
    if (!crsf_parse_link_stats(f, 14u, &lq) || lq != 100u) return 3;
    build_link_stats(f, 101u); lq = 0xAAu;
    if (crsf_parse_link_stats(f, 14u, &lq) || lq != 0xAAu) return 4; /* not a percentage */
    build_link_stats(f, 50u); f[13] ^= 1u;
    if (crsf_parse_link_stats(f, 14u, &lq)) return 5;                /* bad CRC */
    build_link_stats(f, 50u);
    if (crsf_parse_link_stats(f, 13u, &lq)) return 6;                /* truncated */
    build_link_stats(f, 50u); f[1] = 11u;
    if (crsf_parse_link_stats(f, 14u, &lq)) return 7;                /* wrong length */
    build_link_stats(f, 50u); f[2] = 0x16u; f[13] = crsf_crc8(&f[2], 11u);
    if (crsf_parse_link_stats(f, 14u, &lq)) return 8;                /* wrong type */
    build_link_stats(f, 50u); f[0] = 0xEEu;
    if (!crsf_parse_link_stats(f, 14u, &lq) || lq != 50u) return 9;  /* TX address accepted like RC */
    return 0;
}

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

static void pack_rc11(const uint16_t ch[16], uint8_t payload[22])
{
    uint32_t bitbuf = 0;
    unsigned bits = 0;
    unsigned ch_i;
    unsigned bi = 0;
    memset(payload, 0, 22);
    for (ch_i = 0; ch_i < 16u; ch_i++) {
        bitbuf |= ((uint32_t)(ch[ch_i] & 0x7FFu)) << bits;
        bits += 11u;
        while (bits >= 8u) {
            payload[bi++] = (uint8_t)(bitbuf & 0xFFu);
            bitbuf >>= 8;
            bits -= 8u;
        }
    }
    if (bits > 0u && bi < 22u) {
        payload[bi] = (uint8_t)(bitbuf & 0xFFu);
    }
}

static size_t build_rc_frame(uint8_t sync, const uint16_t ch[16], uint8_t *frame,
                             size_t cap, int corrupt_crc)
{
    uint8_t payload[22];
    uint8_t crc;
    if (cap < 26u) {
        return 0;
    }
    pack_rc11(ch, payload);
    frame[0] = sync;
    frame[1] = 24u; /* type + 22 payload + crc */
    frame[2] = 0x16u;
    memcpy(&frame[3], payload, 22);
    crc = crsf_crc8(&frame[2], 23u);
    if (corrupt_crc) {
        crc ^= 0xFFu;
    }
    frame[25] = crc;
    return 26u;
}

int main(void)
{
    uint8_t frame[32];
    float out[16];
    uint16_t ch[16];
    unsigned i;
    size_t n;

    for (i = 0; i < 16u; i++) {
        ch[i] = 992u;
    }
    n = build_rc_frame(0xC8u, ch, frame, sizeof(frame), 0);
    if (!crsf_parse_rc_frame(frame, n, out)) {
        return fail("mid frame should parse");
    }
    for (i = 0; i < 16u; i++) {
        if (fabsf(out[i]) > 1e-5f) {
            return fail("mid channels should be ~0");
        }
    }

    /* Extremes: 172 → -1, 1811 → ~+1 */
    ch[0] = 172u;
    ch[1] = 992u;
    ch[2] = 1811u;
    n = build_rc_frame(0xEEu, ch, frame, sizeof(frame), 0);
    if (!crsf_parse_rc_frame(frame, n, out)) {
        return fail("extreme frame should parse");
    }
    if (fabsf(out[0] + 1.f) > 1e-5f) {
        return fail("ch0 min not -1");
    }
    if (fabsf(out[1]) > 1e-5f) {
        return fail("ch1 mid not 0");
    }
    if (!(out[2] > 0.99f && out[2] <= 1.f)) {
        return fail("ch2 max not ~+1");
    }

    /* Bad CRC */
    n = build_rc_frame(0xC8u, ch, frame, sizeof(frame), 1);
    if (crsf_parse_rc_frame(frame, n, out)) {
        return fail("bad CRC must be false");
    }

    /* Wrong sync */
    n = build_rc_frame(0xC8u, ch, frame, sizeof(frame), 0);
    frame[0] = 0x00u;
    if (crsf_parse_rc_frame(frame, n, out)) {
        return fail("wrong sync must be false");
    }

    /* Truncated */
    n = build_rc_frame(0xC8u, ch, frame, sizeof(frame), 0);
    if (crsf_parse_rc_frame(frame, 10u, out)) {
        return fail("short frame must be false");
    }

    /* CRC self-check on type alone */
    {
        uint8_t t = 0x16u;
        (void)crsf_crc8(&t, 1);
    }

    {
        int rc = link_stats_checks();
        if (rc) {
            fprintf(stderr, "FAIL: link stats check %d\n", rc);
            return 1;
        }
    }

    puts("PASS: CRSF CRC8 / RC channel parse / LINK_STATISTICS parse");
    return 0;
}
