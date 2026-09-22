/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * DShot TX, selectable 300/600 kbps — public-protocol packet encode +
 * TIM+DMA bit-period burst. Encode is not Betaflight-derived. Burst only
 * if board_t gave a valid timer+pin (never on dummy IR). Motor count
 * capped at DSHOT_MOTOR_COUNT. Default 300 kbps (bench bring-up); the
 * header previously claimed DShot600 while the timers were 300k — the
 * rate is now an explicit, switchable setting.
 *
 * Bit timing (public DShot): bit period ~1.67 µs @ 600 kbit; logical 0/1
 * are ~1/3 and ~2/3 duty within that period. HAL programs ARR from bit_hz;
 * we emit CCR high-time ticks for each of the 16 packet bits (MSB first),
 * plus a trailing low slot as inter-frame idle.
 */
#include "drivers/dshot.h"
#include "drivers/dshot_telem.h"
#include "board/board.h"
#include "hal/hal.h"

#include <string.h>
#include <math.h>
#include "flight/arming.h"
#include "sched/tasks.h"
static bool g_output_ok;
static unsigned g_kbps = DSHOT_KBPS_300;

static hal_tim_dma_t *g_tim[DSHOT_MOTOR_COUNT];
static unsigned g_bound;
static uint16_t g_last_pkt[DSHOT_MOTOR_COUNT];
static uint16_t g_burst[DSHOT_MOTOR_COUNT][DSHOT_BURST_LEN];

uint16_t dshot_encode_packet_ex(uint16_t throttle11, bool request_telem)
{
    uint16_t value = (uint16_t)((throttle11 << 1) | (request_telem ? 1u : 0u));
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

uint16_t dshot_encode_packet(uint16_t throttle11)
{
    return dshot_encode_packet_ex(throttle11, false);
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
        cfg.bit_hz = 1000u * g_kbps;
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
        /* DShot throttle 48..2047; 0 = disarmed command. Dummy never bursts.
         * R0c: request telem on M1–M4 when bidir enabled so ESCs reply. */
        th = (n <= 0.f) ? 0u : (uint16_t)(48u + (unsigned)(n * (2047u - 48u)));
        {
            bool telem = dshot_bidir_enabled();
            g_last_pkt[i] = dshot_encode_packet_ex(th, telem);
        }
        if (g_tim[i]) {
            dshot_expand_frame(g_last_pkt[i], g_burst[i], DSHOT_BURST_LEN);
            if(!hal_tim_dma_start_burst(g_tim[i], g_burst[i], DSHOT_BURST_LEN)) {g_output_ok=false; arming_disarm();}
        }
    }
    /* Listen-after-TX on M1–M4; TX TIM3_UP / TIM1_UP DMA paths unchanged. */
    if (dshot_bidir_enabled()) {
        dshot_telem_arm_listen_all();
        dshot_telem_poll_all();
    }
}

bool dshot_set_speed_kbps(unsigned kbps)
{
    if (kbps != DSHOT_KBPS_300 && kbps != DSHOT_KBPS_600) {
        return false;
    }
    if (arming_state() == ARM_ARMED || bench_motor_active()) {
        return false; /* no re-timing in flight or during a bench pulse/sequence */
    }
    if (!hal_tim_dma_set_bit_rate(1000u * kbps)) {
        return false;
    }
    g_kbps = kbps;
    return true;
}

unsigned dshot_speed_kbps(void)
{
    return g_kbps;
}

unsigned dshot_bound_count(void)
{
    return g_bound;
}

bool dshot_is_healthy(void){return g_bound==4 && g_output_ok;}
