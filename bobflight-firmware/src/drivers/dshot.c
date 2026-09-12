/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * DShot600 — public-protocol packet encode + TIM+DMA bit-period burst.
 * Encode is not Betaflight-derived. Burst only if board_t gave a valid
 * timer+pin (never on dummy IR). Motor count capped at DSHOT_MOTOR_COUNT.
 *
 * Bit timing (public DShot): bit period ~1.67 µs @ 600 kbit; logical 0/1
 * are ~1/3 and ~2/3 duty within that period. HAL programs ARR from bit_hz;
 * we emit CCR high-time ticks for each of the 16 packet bits (MSB first),
 * plus a trailing low slot as inter-frame idle.
 */
#include "drivers/dshot.h"
#include "board/board.h"
#include "hal/hal.h"

#include <string.h>
#include <math.h>
#include "flight/arming.h"
static bool g_output_ok;

static hal_tim_dma_t *g_tim[DSHOT_MOTOR_COUNT];
static unsigned g_bound;
static uint16_t g_last_pkt[DSHOT_MOTOR_COUNT];
static uint16_t g_burst[DSHOT_MOTOR_COUNT][DSHOT_BURST_LEN];

uint16_t dshot_encode_packet(uint16_t throttle11)
{
    uint16_t value = (uint16_t)(throttle11 << 1); /* telem bit 0 */
    uint16_t crc = 0;
    uint16_t c = value;
    unsigned i;
    for (i = 0; i < 3u; i++) {
        crc ^= c;
        c = (uint16_t)(c >> 4);
    }
    crc &= 0xFu;
    return (uint16_t)((value << 4) | crc);
}

void dshot_expand_frame(uint16_t packet, uint16_t *out, size_t out_n)
{
    unsigned i;
    if (!out || out_n < DSHOT_BURST_LEN) {
        return;
    }
    for (i = 0; i < DSHOT_FRAME_BITS; i++) {
        /* MSB first */
        unsigned bit = (packet >> (15u - i)) & 1u;
        out[i] = (uint16_t)(bit ? DSHOT_BIT1_HIGH : DSHOT_BIT0_HIGH);
    }
    for(i=DSHOT_FRAME_BITS;i<DSHOT_BURST_LEN;i++)out[i]=0; /* idle / reset slot */
    (void)DSHOT_BIT_TICKS;
}

void dshot_init(void)
{
    const board_t *b = board_get();
    unsigned i;
    g_bound = 0;
    g_output_ok=true;
    for (i = 0; i < DSHOT_MOTOR_COUNT; i++) {
        g_tim[i] = NULL;
        g_last_pkt[i] = 0;
        memset(g_burst[i], 0, sizeof(g_burst[i]));
    }
    if (!b || !board_pins_live()) {
        return;
    }
    for (i = 0; i < b->motor_count && i < DSHOT_MOTOR_COUNT; i++) {
        hal_tim_dma_cfg_t cfg;
        if (!hal_pin_valid(b->motors[i].pin) ||
            b->motors[i].timer == 0 || b->motors[i].channel == 0) {
            continue;
        }
        cfg.tim = b->motors[i].timer;
        cfg.channel = b->motors[i].channel;
        cfg.pin = b->motors[i].pin;
        cfg.bit_hz = 300000u;
        g_tim[i] = hal_tim_dma_open_cfg(&cfg);
        if (g_tim[i]) {
            g_bound++;
        }
    }
}

void motor_safe_idle(void)
{
    const board_t *b = board_get();
    unsigned i;
    if (!b) {
        return;
    }
    for (i = 0; i < b->motor_count && i < DSHOT_MOTOR_COUNT; i++) {
        if (hal_pin_valid(b->motors[i].pin) && board_mmio_permitted()) {
            hal_gpio_init(b->motors[i].pin, HAL_GPIO_OUT);
            hal_gpio_write(b->motors[i].pin, false);
        }
    }
}

void dshot_write(const float motor[DSHOT_MOTOR_COUNT])
{
    unsigned i;
    if (!motor) {
        return;
    }
    for (i = 0; i < DSHOT_MOTOR_COUNT; i++) {
        float n = motor[i];
        if(!isfinite(n) || !g_output_ok) n=0.f;
        uint16_t th;
        if (n < 0.f) {
            n = 0.f;
        }
        if (n > 1.f) {
            n = 1.f;
        }
        /* DShot throttle 48..2047; 0 = disarmed command. Dummy never bursts. */
        th = (n <= 0.f) ? 0u : (uint16_t)(48u + (unsigned)(n * (2047u - 48u)));
        g_last_pkt[i] = dshot_encode_packet(th);
        if (g_tim[i]) {
            dshot_expand_frame(g_last_pkt[i], g_burst[i], DSHOT_BURST_LEN);
            if(!hal_tim_dma_start_burst(g_tim[i], g_burst[i], DSHOT_BURST_LEN)) {g_output_ok=false; arming_disarm();}
        }
    }
}

unsigned dshot_bound_count(void)
{
    return g_bound;
}

bool dshot_is_healthy(void){return g_bound==4 && g_output_ok;}
