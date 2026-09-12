/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Init phases → cooperative scheduler loop.
 */
#include "app/init.h"
#include "sched/scheduler.h"
#include "drivers/cli.h"
#include "hal/hal.h"
#include "board/board.h"
#include "board/pins_generated.h"

#ifdef BOBFLIGHT_HOST
#include <stdio.h>
#include <stdlib.h>
#else
#include "hal/stm32f7/boot_crumb.h"
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
     * First thing in C (before app_init): sticky crumb=1 + crude PA2 short
     * pulse via GPIOA MMIO — proves entered C without HAL / board_mmio.
     */
    boot_crumb_set(BOOT_CRUMB_MAIN);
    boot_pa2_crude_short_pulse();
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
    for (unsigned i = 0; i < slices; i++) {
        scheduler_run();
        /* Host harness: cascade can eat every slice in a tight loop.
         * Drain stdin CDC each iteration so piped help/status still run. */
        cli_poll();
        if (cli_reboot_requested()) {
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
        main_led_heartbeat_tick();
        if (cli_reboot_requested()) {
            *((volatile uint32_t*)0xE000ED0Cu)=0x05FA0004u;
            for(;;){}
        }
    }
#endif
#endif
}
