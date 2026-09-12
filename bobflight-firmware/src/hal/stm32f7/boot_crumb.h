/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Sticky boot stage crumb in .noinit (survives HardFault; not BSS-cleared
 * after Reset_Handler seeds it). HardFault blinks N slow then ~20 Hz.
 *
 * Stages (set BEFORE entering each stage):
 *   0 = pre-main (Reset_Handler after BSS)
 *   1 = main-entered
 *   2 = pre-board
 *   3 = post-board
 *   4 = pre-clock
 *   5 = post-clock
 *   6 = pre-USB
 *   7 = post-USB
 */
#ifndef BOBFLIGHT_BOOT_CRUMB_H
#define BOBFLIGHT_BOOT_CRUMB_H

#include <stdint.h>

/* Normal builds keep sticky fault stages, but skip blocking success patterns. */
#ifndef BOBFLIGHT_BOOT_LED_DIAGNOSTICS
#define BOBFLIGHT_BOOT_LED_DIAGNOSTICS 0
#endif

#define BOOT_CRUMB_PRE_MAIN  0u
#define BOOT_CRUMB_MAIN      1u
#define BOOT_CRUMB_PRE_BOARD 2u
#define BOOT_CRUMB_POST_BOARD 3u
#define BOOT_CRUMB_PRE_CLOCK 4u
#define BOOT_CRUMB_POST_CLOCK 5u
#define BOOT_CRUMB_PRE_USB   6u
#define BOOT_CRUMB_POST_USB  7u

/** Sticky crumb — section .noinit / NOLOAD (not wiped by BSS clear after seed). */
extern volatile uint8_t g_boot_crumb;

/** Set sticky crumb (MCU only). */
void boot_crumb_set(uint8_t stage);

#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS
/** Crude PA2 short pulse via GPIOA MMIO — diagnostic build only. */
void boot_pa2_crude_short_pulse(void);
#endif

#endif /* BOBFLIGHT_BOOT_CRUMB_H */
