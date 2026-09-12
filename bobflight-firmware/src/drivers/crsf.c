/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * CRSF RX — clean-room UART frame parser from public CRSF/ELRS protocol docs
 * (TBS CRSF spec / crsf-wg wiki). CRC8 poly 0xD5 over type+payload.
 * Pins / UART from board_get(); never mark fresh on empty read or dummy IR.
 */
#include "drivers/rx.h"
#include "drivers/rx_internal.h"
#include "drivers/crsf.h"
#include "board/board.h"
#include "hal/hal.h"

#include <string.h>

/* Sync / device address bytes commonly seen on FC UART (public CRSF). */
#define CRSF_SYNC_FC     0xC8u
#define CRSF_SYNC_TX     0xEEu
#define CRSF_TYPE_RC     0x16u
#define CRSF_MAX_FRAME   64u
#define CRSF_RC_PAYLOAD  22u /* 16 × 11-bit channels */
#define CRSF_CH_MID      992u
#define CRSF_CH_SPAN     820u /* ~172..1811 → normalize sticks */

static hal_uart_t *g_uart;
static uint8_t g_rxbuf[CRSF_MAX_FRAME * 2u];
static unsigned g_rxlen;
static bool g_taer;
static uint32_t g_crc_errors, g_stream_resets, g_last_poll, g_last_bytes;
static bool g_polled;
uint32_t crsf_crc_errors(void) { return g_crc_errors; }
uint32_t crsf_stream_resets(void) { return g_stream_resets; }
const char *crsf_map(void) { return g_taer ? "TAER" : "AETR"; }
bool crsf_set_map(const char *map) {
    if (!map || (strcmp(map,"AETR") && strcmp(map,"TAER"))) return false;
    g_taer = !strcmp(map,"TAER");
    return true;
}

/* CRC8, poly 0xD5 (x^8+x^7+x^6+x^4+x^2+1) — public CRSF spec. */
uint8_t crsf_crc8(const uint8_t *data, size_t len)
{
    uint8_t crc = 0;
    size_t i;
    unsigned bit;
    for (i = 0; i < len; i++) {
        crc ^= data[i];
        for (bit = 0; bit < 8u; bit++) {
            if (crc & 0x80u) {
                crc = (uint8_t)((crc << 1) ^ 0xD5u);
            } else {
                crc = (uint8_t)(crc << 1);
            }
        }
    }
    return crc;
}

static float crsf_norm_channel(unsigned raw11)
{
    /* Mid 992 → 0; map roughly to [-1,1] using public 172..1811 span. */
    int v = (int)raw11 - (int)CRSF_CH_MID;
    float n = (float)v / (float)CRSF_CH_SPAN;
    if (n < -1.f) {
        n = -1.f;
    }
    if (n > 1.f) {
        n = 1.f;
    }
    return n;
}

static void crsf_unpack_rc(const uint8_t *payload, float out[16])
{
    /* 16×11-bit little-endian packed (public CRSF_FRAMETYPE_RC_CHANNELS_PACKED). */
    uint32_t bitbuf = 0;
    unsigned bits = 0;
    unsigned ch;
    unsigned bi = 0;
    for (ch = 0; ch < 16u; ch++) {
        while (bits < 11u) {
            bitbuf |= ((uint32_t)payload[bi++]) << bits;
            bits += 8u;
        }
        out[ch] = crsf_norm_channel(bitbuf & 0x7FFu);
        bitbuf >>= 11;
        bits -= 11u;
    }
}

bool crsf_parse_rc_frame(const uint8_t *frame, size_t n, float out[16])
{
    uint8_t len;
    unsigned frame_bytes;
    const uint8_t *type_ptr;
    uint8_t expect_crc;

    if (!frame || !out || n < 4u) {
        return false;
    }
    if (frame[0] != CRSF_SYNC_FC && frame[0] != CRSF_SYNC_TX) {
        return false;
    }
    len = frame[1];
    if (len != (uint8_t)(1u + CRSF_RC_PAYLOAD + 1u)) {
        return false;
    }
    frame_bytes = (unsigned)len + 2u;
    if (n < frame_bytes) {
        return false;
    }
    type_ptr = &frame[2];
    if (type_ptr[0] != CRSF_TYPE_RC) {
        return false;
    }
    expect_crc = crsf_crc8(type_ptr, (size_t)len - 1u);
    if (expect_crc != frame[frame_bytes - 1u]) {
        return false;
    }
    crsf_unpack_rc(&type_ptr[1], out);
    return true;
}

static void crsf_consume_frames(void)
{
    while (g_rxlen >= 3u) {
        uint8_t len;
        unsigned frame_bytes;
        const uint8_t *type_ptr;
        uint8_t expect_crc;
        uint8_t got_crc;
        float ch[16];

        /* Resync to known address. */
        if (g_rxbuf[0] != CRSF_SYNC_FC && g_rxbuf[0] != CRSF_SYNC_TX) {
            memmove(g_rxbuf, g_rxbuf + 1, g_rxlen - 1u);
            g_rxlen--;
            continue;
        }

        len = g_rxbuf[1];
        /* len = type + payload + crc; reject nonsense. */
        if (len < 2u || len > (CRSF_MAX_FRAME - 2u)) {
            memmove(g_rxbuf, g_rxbuf + 1, g_rxlen - 1u);
            g_rxlen--;
            continue;
        }
        frame_bytes = (unsigned)len + 2u; /* addr + len + body */
        if (g_rxlen < frame_bytes) {
            return; /* wait for more bytes */
        }

        type_ptr = &g_rxbuf[2];
        expect_crc = crsf_crc8(type_ptr, (size_t)len - 1u);
        got_crc = g_rxbuf[frame_bytes - 1u];
        if (expect_crc != got_crc) {
            g_crc_errors++;
            memmove(g_rxbuf, g_rxbuf + 1, g_rxlen - 1u);
            g_rxlen--;
            continue;
        }

        if (type_ptr[0] == CRSF_TYPE_RC &&
            len == (uint8_t)(1u + CRSF_RC_PAYLOAD + 1u)) {
            crsf_unpack_rc(&type_ptr[1], ch);
            /* Valid CRC+frame only — never on empty/dummy. */
            float controls[16];
            crsf_to_controls(ch,controls);
            rx_stub_set_channels(controls,16,true);
        }

        if (g_rxlen > frame_bytes) {
            memmove(g_rxbuf, g_rxbuf + frame_bytes, g_rxlen - frame_bytes);
        }
        g_rxlen -= frame_bytes;
    }
}

static bool crsf_init(void)
{
    const board_t *b = board_get();
    g_uart = NULL;
    g_rxlen = 0;
    g_crc_errors = g_stream_resets = 0;
    g_polled = false;
    if (!b || !board_pins_live() || b->rx_uart == 0) {
        return true;
    }
    if (!hal_pin_valid(b->rx_pin) && !hal_pin_valid(b->tx_pin)) {
        return true;
    }
    {
        hal_uart_cfg_t cfg;
        cfg.instance = b->rx_uart;
        cfg.baud = 420000u; /* CRSF default */
        cfg.rx = b->rx_pin;
        cfg.tx = b->tx_pin;
        g_uart = hal_uart_open_cfg(&cfg);
    }
    return true;
}

static void crsf_poll(void)
{
    uint8_t scratch[64];
    size_t n = 0;
    float mid[4] = {0.f, 0.f, 0.f, 0.f};
    uint32_t now = hal_millis();

    if (!g_uart) {
        /* Dummy / unbound — never mark fresh. */
        rx_stub_set_channels(mid, 4, false);
        return;
    }

    /* After a scheduler stall, bytes buffered before the stall must not
     * revive the link. Drain at most one 512-byte UART ring, then await new data. */
    if (g_polled && (uint32_t)(now-g_last_poll)>10u) {
        for (unsigned i=0;i<8;i++) if (!hal_uart_read(g_uart,scratch,sizeof(scratch))) break;
        g_rxlen=0; g_stream_resets++; g_last_poll=now;
        return;
    }
    g_polled=true; g_last_poll=now;
    if (g_rxlen && (uint32_t)(now-g_last_bytes)>10u) {
        g_rxlen=0; g_stream_resets++;
    }

    n = hal_uart_read(g_uart, scratch, sizeof(scratch));
    if (n == 0) {
        /* Bound but silent — do not invent fresh; leave last decode. */
        return;
    }
    g_last_bytes=now;

    if (g_rxlen + (unsigned)n > sizeof(g_rxbuf)) {
        g_rxlen = 0; /* overflow: resync */
    }
    if (g_rxlen + (unsigned)n <= sizeof(g_rxbuf)) {
        memcpy(g_rxbuf + g_rxlen, scratch, n);
        g_rxlen += (unsigned)n;
        crsf_consume_frames();
    }
}

const rx_protocol_t rx_crsf = {
    .name = "CRSF",
    .init = crsf_init,
    .poll = crsf_poll,
};

bool crsf_uart_bound(void)
{
    return g_uart != NULL;
}

void crsf_to_controls(const float raw[16],float controls[16]) {
    memcpy(controls,raw,16*sizeof(float));
    controls[0]=raw[g_taer?1:0];controls[1]=raw[g_taer?2:1];controls[2]=raw[3];
    controls[3]=(raw[g_taer?0:2]+1.f)*0.5f;
    if(controls[3]<0.f)controls[3]=0.f;
    if(controls[3]>1.f)controls[3]=1.f;
}
