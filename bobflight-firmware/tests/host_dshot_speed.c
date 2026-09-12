/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host tests: DShot bit-rate selection (default, switch, validation, arm
 * refusal). Links arming + dshot; stubs board/HAL surfaces.
 */
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "drivers/dshot.h"
#include "hal/hal.h"
#include "board/board.h"

#include <stdbool.h>
#include <stdio.h>

/* --- stubs for board / HAL / drivers --- */
static float g_rc[16];

const float *rx_channels(void)
{
    return g_rc;
}

bool gyro_is_healthy(void)
{
    return true;
}

bool failsafe_active(void)
{
    return false;
}

const board_t *board_get(void)
{
    return NULL; /* dshot_init binds nothing on the host */
}

bool board_pins_live(void)
{
    return false;
}

bool board_mmio_permitted(void)
{
    return false;
}

bool hal_tim_dma_set_bit_rate(uint32_t hz)
{
    return hz == 300000u || hz == 600000u;
}

hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *cfg)
{
    (void)cfg;
    return NULL;
}

bool hal_tim_dma_start_burst(hal_tim_dma_t *t, const uint16_t *words, size_t n)
{
    (void)t; (void)words; (void)n;
    return false;
}

void hal_gpio_init(hal_pin_t pin, hal_gpio_mode_t mode)
{
    (void)pin; (void)mode;
}

void hal_gpio_write(hal_pin_t pin, bool level)
{
    (void)pin; (void)level;
}

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

int main(void)
{
    arming_init();
    dshot_init();

    /* 1. Default is the baseline-preserving 300 kbps. */
    if (dshot_speed_kbps() != DSHOT_KBPS_300) {
        return fail("default must be 300 kbps");
    }

    /* 2. Switch to 600 and back. */
    if (!dshot_set_speed_kbps(DSHOT_KBPS_600)) {
        return fail("switch to 600 must succeed");
    }
    if (dshot_speed_kbps() != DSHOT_KBPS_600) {
        return fail("speed must report 600 after switch");
    }
    if (!dshot_set_speed_kbps(DSHOT_KBPS_300)) {
        return fail("switch back to 300 must succeed");
    }

    /* 3. Nonsense rates refused; state unchanged. */
    if (dshot_set_speed_kbps(42u) || dshot_set_speed_kbps(1200u)) {
        return fail("invalid rates must be refused");
    }
    if (dshot_speed_kbps() != DSHOT_KBPS_300) {
        return fail("state must be unchanged after refusal");
    }

    /* 4. No re-timing while armed. */
    arming_set_gyro_healthy(true);
    g_rc[3] = 0.0f;
    if (!arming_try_arm() || arming_state() != ARM_ARMED) {
        return fail("helper: expected to arm");
    }
    if (dshot_set_speed_kbps(DSHOT_KBPS_600)) {
        return fail("speed switch must be refused while armed");
    }
    if (dshot_speed_kbps() != DSHOT_KBPS_300) {
        return fail("refused switch must not change state");
    }
    arming_disarm();
    if (!dshot_set_speed_kbps(DSHOT_KBPS_600)) {
        return fail("switch must succeed once disarmed");
    }

    puts("PASS: dshot speed selection (default, switch, validation, arm gate)");
    return 0;
}
