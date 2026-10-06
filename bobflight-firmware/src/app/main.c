/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Init phases → cooperative scheduler loop.
 */
#include "app/init.h"
#include "sched/scheduler.h"
#include "sched/loop_rate.h"
#include "drivers/cli.h"
#include "hal/hal.h"
#include "board/board.h"
#include "board/pins_generated.h"

#ifdef BOBFLIGHT_HOST
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#else
#include "hal/boot_crumb.h"
#endif

#ifndef BOBFLIGHT_HOST
/** Slow status LED toggle (~2 Hz) while main loop is healthy (MMIO gated). */
static void main_led_heartbeat_tick(void)
{
    static uint32_t last_ms;
    static bool level;
    const hal_pin_t led = BOARD_GENERATED_LED0_PIN;
    uint32_t now;

    if (!board_mmio_permitted() || !hal_pin_valid(led)) {
        return;
    }

    now = hal_millis();
    if ((now - last_ms) < 250u) {
        return;
    }
    last_ms = now;
    level = !level;
    hal_gpio_write(led, level);
}
#endif

int main(void)
{
#ifndef BOBFLIGHT_HOST
    /*
     * Keep the sticky stage in all MCU builds. The blocking PA2 success
     * pulse is opt-in for bring-up, not part of the normal boot path.
     */
    boot_crumb_set(BOOT_CRUMB_MAIN);
#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS
    hal_boot_diagnostic_pulse();
#endif
#endif

    if (!app_init()) {
#ifdef BOBFLIGHT_HOST
        fprintf(stderr, "app_init failed\n");
#endif
        return 1;
    }

#ifdef BOBFLIGHT_HOST
    /* Host smoke: run a bounded number of slices then exit. */
    const unsigned slices = 20000;
    /* Test-only warm reboot: BOBFLIGHT_HOST_REBOOT_REINIT=1 re-runs app_init
     * on `reboot` with the process-local flash model kept, so save + reboot
     * paths (e.g. loop_rate_hz) are exercised end to end. Default: exit. */
    const char *reinit = getenv("BOBFLIGHT_HOST_REBOOT_REINIT");
    unsigned reboots = 0;
    for (unsigned i = 0; i < slices; i++) {
        scheduler_run();
        /* Host harness: cascade can eat every slice in a tight loop.
         * Drain stdin CDC each iteration so piped help/status still run. */
        cli_poll();
        loop_rate_tick();
        if (cli_reboot_requested()) {
            if (reinit && strcmp(reinit, "1") == 0 && reboots < 4u) {
                reboots++;
                if (!app_init()) { fprintf(stderr, "app_init failed after reboot\n"); return 1; }
                continue;
            }
            break;
        }
    }
    printf("bobflight host smoke: ok (cascade exercised)\n");
    return 0;
#else
    /* IWDG /32, 250 counts: nominal 250 ms. A stuck loop resets to motors-off. */
    /* Start IWDG first: this forces its LSI clock on before register updates. */
    *((volatile uint32_t*)0x40003000u)=0xCCCC;
    *((volatile uint32_t*)0x40003000u)=0x5555;
    *((volatile uint32_t*)0x40003004u)=3;
    *((volatile uint32_t*)0x40003008u)=249;
    /* If updates stall, the now-running watchdog resets instead of hanging. */
    while(*((volatile uint32_t*)0x4000300Cu) & 7u){}
    *((volatile uint32_t*)0x40003000u)=0xAAAA;
#if defined(BOBFLIGHT_USB_ONLY)
    for (;;) {
        *((volatile uint32_t*)0x40003000u)=0xAAAA;
        cli_poll();
        main_led_heartbeat_tick();
    }
#else
    for (;;) {
        *((volatile uint32_t*)0x40003000u)=0xAAAA;
        scheduler_run();
        /* Belt-and-suspenders: keep TinyUSB CDC polled even if sched starves */
        cli_poll();
        /* Outside the cascade: bidir/timebase/overrun-guard rate decisions. */
        loop_rate_tick();
        main_led_heartbeat_tick();
        if (cli_reboot_requested()) {
            *((volatile uint32_t*)0xE000ED0Cu)=0x05FA0004u;
            for(;;){}
        }
    }
#endif
#endif
}
