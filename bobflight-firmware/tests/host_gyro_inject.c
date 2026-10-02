/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host unit checks for gyro_host_inject_dps (no SPI / no MMIO fake).
 */
#include "drivers/gyro.h"
#include "board/board.h"
#include "flight/arming.h"
#include "flight/config.h"

#include <math.h>
#include <stdio.h>
#include <string.h>

#include "hal/hal.h"

hal_spi_bus_t *hal_spi_open(unsigned bus_index)
{
    (void)bus_index;
    return NULL;
}
uint32_t hal_spi_set_hz(hal_spi_bus_t *bus, uint32_t max_hz)
{
    (void)bus;
    (void)max_hz;
    return 0u;
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


uint32_t hal_millis(void){return 0;}
bool hal_usb_cdc_connected(void){return false;}
arm_state_t arming_state(void){return ARM_DISARMED;}

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

    /* BB1 QA M23: the Blackbox filter-flags snapshot (real gyro.c, no stub) says a notch runs only when its
     * reason is "ok": a configured notch that is above Nyquist at the filter rate, or off, is not running. */
    if (gyro_notch_active_snapshot(1u) || gyro_notch_active_snapshot(2u)) {
        return fail("no notch running before any notch is set");
    }
    gyro_filter_set_dt(0.001f); /* 1 kHz filter rate: Nyquist margin 450 Hz */
    if (!config_set_gyro_notch(1u, 200.f, 150.f) || !config_set_gyro_notch(2u, 900.f, 800.f)) {
        return fail("notch settings rejected");
    }
    bool active = false;
    const char *reason = NULL;
    if (!gyro_notch_status(1u, &active, &reason) || !active || strcmp(reason, "ok") != 0 ||
        !gyro_notch_active_snapshot(1u)) {
        return fail("notch 1 (200 Hz) must run and the snapshot must say so");
    }
    if (!gyro_notch_status(2u, &active, &reason) || active || strcmp(reason, "above-nyquist") != 0 ||
        gyro_notch_active_snapshot(2u)) {
        return fail("notch 2 (900 Hz at 1 kHz) is configured but above Nyquist: snapshot must be false");
    }
    if (gyro_notch_active_snapshot(0u) || gyro_notch_active_snapshot(3u)) {
        return fail("snapshot index out of range");
    }
    gyro_filter_set_dt(0.00025f); /* 4 kHz: 900 Hz is valid again */
    if (!gyro_notch_status(2u, &active, &reason) || !active || !gyro_notch_active_snapshot(2u)) {
        return fail("notch 2 must run at 4 kHz");
    }
    if (!config_set_gyro_notch(1u, 0.f, 0.f) || !gyro_notch_status(1u, &active, &reason) || active ||
        strcmp(reason, "off") != 0 || gyro_notch_active_snapshot(1u)) {
        return fail("notch 1 off: snapshot must be false");
    }

    puts("PASS: gyro host inject dps; Blackbox notch snapshot follows the notch reason (ok / above-nyquist / off)");
    return 0;
}
