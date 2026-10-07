/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_HAL_STM32F4_USB_TIME_H
#define BOBFLIGHT_HAL_STM32F4_USB_TIME_H

#include <stdbool.h>
#include <stdint.h>
#include "clock_plan.h"

#if !defined(__arm__) || !defined(__thumb__)
#error "usb_time requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for usb_time"
#endif

#if defined(BF_F4_COMPONENT_F411XE)
#error "BF_F4_COMPONENT_F411XE must NOT be defined for usb_time"
#endif

/**
 * STM32F405xG USB Timing & Binding Component.
 *
 * CONTRACT & RESPONSIBILITY:
 * - Caller MUST provide clocks from successful verified startup and complete
 *   usb_prepare before real controller use.
 * - Timebase must already use the same established HCLK. Binding checks supplied
 *   rates and health, not an independent measurement of timebase calibration.
 * - Initialize with exclusive ownership, before any USB callbacks can execute;
 *   this module never changes clock binding during runtime.
 * - Binding is not clock measurement or board verification.
 * - Single-bind contract: once SUCCESS, no reset or rebind is permitted.
 * - Read budget (poll_budget) is finite work, NOT a guaranteed wall-clock
 *   deadline or guaranteed service cadence.
 * - Incoming clocks/data ownership belongs strictly to the caller.
 */

extern uint32_t SystemCoreClock;
extern volatile uint32_t bf_f405_usb_time_fault_reason;

/**
 * Bind USB timing component to clock plan and timebase.
 * Requires reset-time Thread mode with IPSR = 0 and PRIMASK = 1 (IRQs masked).
 * Requires clocks->hclk_hz == 168MHz, sysclk_hz == 168MHz, usb_hz == 48MHz.
 * Requires timebase health check (bf_f405_time_read_us) to succeed.
 * On failure, SystemCoreClock remains unchanged.
 * On success, sets SystemCoreClock to 168000000u, sets private bound state to true.
 * Single-shot per reset: once bound successfully, subsequent calls return false.
 */
bool bf_f405_usb_time_bind(const bf_f4_clock_plan_t *clocks);

/**
 * Microsecond wait with finite polling work budget using existing timebase.
 * Requires Thread mode (IPSR = 0) and bound timing component.
 * delay_us must be <= 100000 us (100 ms).
 * poll_budget must be in range 1..1000000.
 * Read budget represents finite polling work, NOT a guaranteed wall-clock
 * deadline or guaranteed service cadence.
 * Duration 0 returns true immediately after a healthy initial snapshot.
 * A false result must not be treated as an elapsed delay.
 * Returns true if delay is reached within budget, false on invalid args,
 * timebase read failure, or budget exhaustion.
 */
bool bf_f405_usb_wait_us(uint32_t delay_us, uint32_t poll_budget);

/**
 * TinyUSB millisecond ticker API.
 * Strong application callback required by TinyUSB no-OS configuration.
 * Returns current timebase milliseconds (wrap-correct).
 * If unbound or timebase is unhealthy, calls noreturn fault(reason 1).
 * Does not write false 0 millis on error.
 */
uint32_t tusb_time_millis_api(void);

/**
 * TinyUSB millisecond delay API.
 * Strong implementation overriding vendored weak default.
 * ms must be <= 100 ms, otherwise calls fault(reason 2).
 * Calls wait_us(ms * 1000, 1000000). On false, calls fault(reason 3).
 */
void tusb_time_delay_ms_api(uint32_t ms);

/**
 * USB timing fault handler.
 * Default weak definition masks IRQs and loops infinitely with NOPs.
 * Accessible volatile uint32_t bf_f405_usb_time_fault_reason holds fault reason.
 */
void bf_f405_usb_time_fault(uint32_t reason) __attribute__((noreturn));

#endif /* BOBFLIGHT_HAL_STM32F4_USB_TIME_H */
