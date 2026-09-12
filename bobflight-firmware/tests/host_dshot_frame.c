/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit checks for DShot300 packet CRC + CCR bit-timing expand.
 */
#include "drivers/dshot.h"
/* --- stubs for symbols dshot.c now references --- */
#include "flight/arming.h"
arm_state_t arming_state(void) { return ARM_DISARMED; }
bool hal_tim_dma_set_bit_rate(uint32_t hz) { return hz==300000u || hz==600000u; }


#include <stdio.h>
#include <string.h>

/* --- board/hal stubs (encode path is pure; linker needs symbols from dshot.c) --- */
#include "board/board.h"
#include "hal/hal.h"

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

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

int main(void)
{
    /* Known throttle → packet (telem=0, nibble-XOR CRC). */
    if (dshot_encode_packet(0u) != 0x0000u) {
        return fail("throttle 0 packet");
    }
    if (dshot_encode_packet(48u) != 0x0606u) {
        return fail("throttle 48 packet");
    }
    if (dshot_encode_packet(1048u) != 0x830Bu) {
        return fail("throttle 1048 packet");
    }
    if (dshot_encode_packet(2047u) != 0xFFEEu) {
        return fail("throttle 2047 packet");
    }

    /* Expand MSB-first; idle slot 0; length 17. */
    {
        uint16_t out[DSHOT_BURST_LEN];
        uint16_t pkt = dshot_encode_packet(48u); /* 0x0606 */
        unsigned i;
        memset(out, 0xA5, sizeof(out));
        dshot_expand_frame(pkt, out, DSHOT_BURST_LEN);
        if (DSHOT_BURST_LEN != 20u) {
            return fail("burst len != 20");
        }
        for (unsigned tail=16;tail<20;tail++) if(out[tail]!=0) return fail("nonzero tail");
        if (out[DSHOT_FRAME_BITS] != 0u) {
            return fail("idle slot not 0");
        }
        for (i = 0; i < DSHOT_FRAME_BITS; i++) {
            unsigned bit = (pkt >> (15u - i)) & 1u;
            uint16_t expect = bit ? DSHOT_BIT1_HIGH : DSHOT_BIT0_HIGH;
            if (out[i] != expect) {
                return fail("bit duty mismatch");
            }
            if (out[i] != 3u && out[i] != 6u) {
                return fail("duty not bit0/bit1 high ticks");
            }
        }
        /* Short buffer must not write. */
        {
            uint16_t tiny[2] = {9u, 9u};
            dshot_expand_frame(pkt, tiny, 2);
            if (tiny[0] != 9u || tiny[1] != 9u) {
                return fail("short out_n should no-op");
            }
        }
    }

    /* All-zero packet → all bit0 highs + idle. */
    {
        uint16_t out[DSHOT_BURST_LEN];
        unsigned i;
        dshot_expand_frame(0u, out, DSHOT_BURST_LEN);
        for (i = 0; i < DSHOT_FRAME_BITS; i++) {
            if (out[i] != DSHOT_BIT0_HIGH) {
                return fail("zero packet duties");
            }
        }
        if (out[16] != 0u) {
            return fail("zero packet idle");
        }
    }

    (void)DSHOT_BIT_TICKS;
    puts("PASS: DShot300 frame encode / bit timing");
    return 0;
}
