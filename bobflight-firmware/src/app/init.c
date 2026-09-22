/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owned init order (see docs/ARCHITECTURE.md).
 */
#include "app/init.h"
#include "hal/hal.h"
#include "board/board.h"
#include "board/pins_generated.h"
#include "drivers/dshot.h"
#include "drivers/gyro.h"
#include "drivers/rx.h"
#include "drivers/cli.h"
#include "drivers/persist.h"
#include "drivers/power.h"
#include "flight/pid.h"
#include "flight/mixer.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "flight/rates.h"
#include "flight/mode_range.h"
#include "sched/scheduler.h"

#include <string.h>

#ifndef BOBFLIGHT_HOST
#include "hal/stm32f7/boot_crumb.h"
#endif

#ifndef BOBFLIGHT_HOST
/* Updated by hal_clock_init after PLL (or HSI fallback). */
extern uint32_t SystemCoreClock;

/** IRQ-free busywait — early boot must not depend on SysTick/g_ms. */
static void boot_busywait_ms(uint32_t ms)
{
    uint32_t hz = SystemCoreClock;
    volatile uint32_t n;

    if (hz < 1000u) {
        hz = 16000000u;
    }
    /* ~4 cycles/iter guess; scale for ms */
    n = (hz / 1000u) * ms / 4u;
    if (n == 0u) {
        n = 1u;
    }
    while (n--) {
        __asm volatile("nop");
    }
}
#endif

/* Set up the normal main-loop heartbeat without adding any startup waits. */
static void boot_led_init(void)
{
    const hal_pin_t led = BOARD_GENERATED_LED0_PIN;
    if (board_mmio_permitted() && hal_pin_valid(led)) {
        hal_gpio_init(led, HAL_GPIO_OUT);
        hal_gpio_write(led, true);
    }
}

#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS
static void boot_led_pulses(hal_pin_t led, unsigned count, uint32_t on_ms, uint32_t off_ms)
{
    unsigned i;

#ifdef BOBFLIGHT_HOST
    (void)on_ms;
    (void)off_ms;
#endif

    for (i = 0; i < count; i++) {
        hal_gpio_write(led, true);
#ifndef BOBFLIGHT_HOST
        boot_busywait_ms(on_ms);
#endif
        hal_gpio_write(led, false);
#ifndef BOBFLIGHT_HOST
        boot_busywait_ms(off_ms);
#endif
    }
}

/** Early boot LED encodes USB clock path after GPIO init (MMIO gated).
 *  Busywait only (no hal_delay_ms / SysTick). Blink (~200 ms on / 200 ms off):
 *    "hse-pll" → 1, "hsi-pll" → 2, "hsi-raw" → 3, else → 5.
 *  Then LED on 1 s, brief off, leave on so the code is readable once at boot. */
static void boot_led_heartbeat(void)
{
    const hal_pin_t led = BOARD_GENERATED_LED0_PIN;
    unsigned flashes = 5u;
    const char *src;

    if (!board_mmio_permitted() || !hal_pin_valid(led)) {
        return;
    }

    hal_gpio_init(led, HAL_GPIO_OUT);

    src = hal_clock_usb_src();
    if (src != NULL && strcmp(src, "hse-pll") == 0) {
        flashes = 1u;
    } else if (src != NULL && strcmp(src, "hsi-pll") == 0) {
        flashes = 2u;
    } else if (src != NULL && strcmp(src, "hsi-raw") == 0) {
        flashes = 3u;
    } else {
        flashes = 5u; /* unknown / host / unexpected tag */
    }

    boot_led_pulses(led, flashes, 200u, 200u);

    /* Hold so Robert can read the pattern without Device Manager. */
    hal_gpio_write(led, true);
#ifndef BOBFLIGHT_HOST
    boot_busywait_ms(1000u);
#endif
    hal_gpio_write(led, false);
#ifndef BOBFLIGHT_HOST
    boot_busywait_ms(200u);
#endif
    /* Leave LED on until USB path finishes (chirp clears). */
    hal_gpio_write(led, true);
}

/** Two fast chirps — proves USB init path returned (ok or fail-soft). */
static void boot_led_usb_chirp(void)
{
    const hal_pin_t led = BOARD_GENERATED_LED0_PIN;

    if (!board_mmio_permitted() || !hal_pin_valid(led)) {
        return;
    }

    boot_led_pulses(led, 2u, 50u, 50u);
    /* Leave on; main ~2 Hz toggle proves loop reachable. */
    hal_gpio_write(led, true);
}

/** One short ~100 ms pulse — post-board HAL path only (MMIO gated). */
static void boot_led_crumb(void)
{
    const hal_pin_t led = BOARD_GENERATED_LED0_PIN;

    if (!board_mmio_permitted() || !hal_pin_valid(led)) {
        return;
    }

    hal_gpio_init(led, HAL_GPIO_OUT);
    boot_led_pulses(led, 1u, 100u, 100u);
    hal_gpio_write(led, true); /* leave on between crumbs */
}

#endif /* BOBFLIGHT_BOOT_LED_DIAGNOSTICS */

bool app_init(void)
{
    /*
     * Optional success-pattern legend (BOBFLIGHT_BOOT_LED_DIAGNOSTICS=1).
     * Sticky stages and fault reporting remain active when it is OFF.
     * Boot LED legend (PA2 / led0, busywait — no SysTick):
     *   Reset: 3 slow (~250 ms half) in Reset_Handler
     *   main entry: 1 short crude PA2 (before app_init; no HAL)
     *   HardFault / Mem/Bus/Usage: N slow (~200 ms) = sticky stage 1–7
     *     (N=0 → one special long), then rapid ~20 Hz forever
     *   Sticky stages: 0=pre-main 1=main 2=pre-board 3=post-board
     *                  4=pre-clock 5=post-clock 6=pre-USB 7=post-USB
     *   If survives: clock encode 1/2/3/5 + USB 2 chirps + main ~2 Hz
     *
     * ALL pre-board LED = crude PA2 MMIO only (never board_mmio_permitted).
     */
#ifndef BOBFLIGHT_HOST
    /* Stage 2: pre-board — sticky only; LED already pulsed in main (crude). */
    boot_crumb_set(BOOT_CRUMB_PRE_BOARD);
#endif

    /* 1 board — need id / IR before clock (Kakute HSE default) */
    board_init();
    const board_t *b = board_get();

#ifndef BOBFLIGHT_HOST
    boot_crumb_set(BOOT_CRUMB_POST_BOARD);
#endif
    /* Preserve main-loop LED output setup even when success blinks are off. */
    boot_led_init();
#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS
    boot_led_crumb();
#endif

#ifndef BOBFLIGHT_HOST
    boot_crumb_set(BOOT_CRUMB_PRE_CLOCK);
#endif
    /* 2 clock + time — HSE from IR, else Kakute documented 8 MHz assumption.
     * fail-soft: all PLL waits bounded; always returns -> encode + USB skip/chirp. */
    {
        uint32_t hse = b ? b->hse_mhz : 0u;
        if (hse == 0u && b && b->board_id[0]
            && strcmp(b->board_id, "kakute_f7_hdv") == 0) {
            hse = 8u;
        }
        hal_clock_init(hse);
    }
    hal_time_init();

#ifndef BOBFLIGHT_HOST
    boot_crumb_set(BOOT_CRUMB_POST_CLOCK);
#endif
#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS
    /* Optional clock-path display; normal boots go straight to USB settle. */
    boot_led_heartbeat();
#endif

#ifndef BOBFLIGHT_HOST
    /* Brief settle so PLLQ/48 MHz is stable before OTG after DFU leave. */
    boot_busywait_ms(20u);
    boot_crumb_set(BOOT_CRUMB_PRE_USB);
#endif
    /* 3 USB CDC ASAP -- before motors/gyro/long init paths.
     * Fail-soft: skip OTG ONLY if no 48 MHz (hsi-raw). hsi-pll / hse-pll
     * must NOT skip -- field encode 2 means 48 MHz OK; dig is enum/soft-connect.
     * TinyUSB GRSTCTL waits bounded in vendored dwc2_common so tusb_init returns.
     * Optional short settle after PLL before OTG pin/clock/tusb_init. */
#ifndef BOBFLIGHT_HOST
    boot_busywait_ms(5u);
#endif
    if (b && b->usb_enable_cdc) {
        const char *usb_src = hal_clock_usb_src();
        if (usb_src != NULL && strcmp(usb_src, "hsi-raw") == 0) {
            /* No USB 48 MHz -- Device Manager would stay silent; skip hang risk. */
        } else {
            /* hsi-pll / hse-pll / unknown-non-raw -> attempt OTG + soft-connect */
            (void)hal_usb_cdc_init();
        }
    }
#ifndef BOBFLIGHT_HOST
    boot_crumb_set(BOOT_CRUMB_POST_USB);
#endif
#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS
    boot_led_usb_chirp();
#endif
#if defined(BOBFLIGHT_USB_ONLY)
    /* USB-only diagnostic: stop before motors, gyro, RX, and persistence. */
    cli_init();
    return true;
#endif
    cli_init();

    /* 4 motors safe */
    motor_safe_idle();
    dshot_init();

    /* 5 SPI/EXTI/TIM objects — drivers no-op if invalid pins */
    gyro_init();
    rx_init();

    persist_init();
    power_init();

    pid_init();
    mixer_init();
    rates_init();
    mode_range_init();
    arming_init();
    failsafe_init();
    /* Re-apply gyro health after arming_init cleared state */
    arming_set_gyro_healthy(gyro_is_healthy());
    /* Defaults and subsystem init must finish before restoring persistent settings. */
    (void)persist_load();

    /* Scheduler: host/bench path 1000 Hz / denom 1 until R3 first-flight.
     * Kakute 4 kHz uses scheduler_init(8000, 2) + DWT us (Lead); do not
     * claim 8 kHz here while this call stays 1000/1. */
    scheduler_init(1000, 1);
    return true;
}
