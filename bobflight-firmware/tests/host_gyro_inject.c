/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit checks for gyro_host_inject_dps (no SPI / no MMIO fake).
 */
#include "drivers/gyro.h"
#include "board/board.h"
#include "flight/arming.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "hal/hal.h"

hal_spi_bus_t *hal_spi_open(unsigned bus_index)
{
    (void)bus_index;
    return NULL;
}
bool hal_spi_transfer(hal_spi_bus_t *bus, hal_pin_t cs,
                      const uint8_t *tx, uint8_t *rx, size_t len)
{
    (void)bus;
    (void)cs;
    (void)tx;
    (void)rx;
    (void)len;
    return false;
}
bool hal_exti_attach(hal_pin_t pin, hal_exti_cb_t cb, void *ctx)
{
    (void)pin;
    (void)cb;
    (void)ctx;
    return false;
}
void hal_delay_ms(uint32_t ms)
{
    (void)ms;
}


static board_t g_board;
static bool g_arm_gyro;

void arming_set_gyro_healthy(bool healthy)
{
    g_arm_gyro = healthy;
}

const board_t *board_get(void)
{
    return &g_board;
}

bool board_pins_live(void)
{
    return false; /* dummy path — no SPI */
}

bool board_mmio_permitted(void)
{
    return false;
}

static int fail(const char *msg)
{
    fprintf(stderr, "FAIL: %s\n", msg);
    return 1;
}

int main(void)
{
    float dps[3];
    float inj[3] = {12.5f, -3.f, 0.25f};

    memset(&g_board, 0, sizeof(g_board));
    g_board.is_dummy = true;
    strncpy(g_board.board_id, "dummy", sizeof(g_board.board_id) - 1);

    gyro_init();
    if (gyro_is_healthy()) {
        return fail("default init must be unhealthy");
    }
    if (gyro_sample(dps)) {
        return fail("sample without inject must fail");
    }
    if (g_arm_gyro) {
        return fail("arming gyro flag should be false");
    }

    gyro_host_inject_dps(inj, true);
    if (!gyro_is_healthy()) {
        return fail("inject healthy");
    }
    if (!g_arm_gyro) {
        return fail("arming should see healthy");
    }
    if (!gyro_sample(dps)) {
        return fail("sample after inject");
    }
    if (fabsf(dps[0] - inj[0]) > 1e-6f || fabsf(dps[1] - inj[1]) > 1e-6f ||
        fabsf(dps[2] - inj[2]) > 1e-6f) {
        return fail("injected dps mismatch");
    }

    gyro_host_inject_dps(inj, false);
    if (gyro_is_healthy() || gyro_sample(dps)) {
        return fail("inject unhealthy must fail closed");
    }

    gyro_host_inject_dps(inj, true);
    gyro_init(); /* clears inject */
    if (gyro_is_healthy() || gyro_sample(dps)) {
        return fail("gyro_init must clear inject");
    }

    puts("PASS: gyro host inject dps");
    return 0;
}
