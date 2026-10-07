/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_HAL_STM32F4_TIMEBASE_H
#define BOBFLIGHT_HAL_STM32F4_TIMEBASE_H

#include <stdbool.h>
#include <stdint.h>

#if !defined(__arm__) || !defined(__thumb__)
#error "timebase requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for timebase"
#endif

#if defined(BF_F4_COMPONENT_F411XE)
#error "BF_F4_COMPONENT_F411XE must NOT be defined for timebase"
#endif

/* Isolated component, not selected by a hardware backend or bound to hal_micros.
 * Caller supplies established HCLK, not a measurement or a failed clock request.
 * No runtime clock changes. Init: reset-time Thread mode with PRIMASK=1,
 * inactive/nonpending SysTick and exclusive ownership of DWT/SysTick.
 * Whole-MHz HCLK in [1,168] MHz. Valid hardware attempts are one-shot per reset;
 * successful time cannot be reset by another init call. IRQs remain masked.
 * NMI/HardFault callers are rejected. PRIMASK does not prove exclusive ownership.
 *
 * Reads return false without modifying output when uninitialized/unhealthy.
 * Health loss is latched; no coarse fallback or automatic recovery. On failed
 * SysTick configuration we request disabling it, not guarantee hardware accepted
 * that write. Trace/counter enable changes may remain after a failed attempt.
 * Reads and the handler serialize internal state and restore incoming PRIMASK.
 * Each returned value is a snapshot inside that critical section; callers own
 * their output buffers. Milliseconds wrap modulo 2^32, microseconds use uint64_t.
 *
 * Read/ISR must sample strictly MORE OFTEN than one 32-bit cycle wrap
 * (about 25.565 s at 168 MHz). SysTick is configured for 1 ms but this component
 * does not unmask interrupts or prove their delivery. An IRQ blackout missing
 * an entire wrap cannot be detected/recovered from CYCCNT alone. No elapsed-time
 * claim during debugger halts, sleep, runtime clock changes or analog clock loss.
 * CYCCNT is not reset and Cortex-M7's DWT_LAR is never accessed.
 */

bool bf_f405_time_init(uint32_t core_hz);
bool bf_f405_time_read_us(uint64_t *out);
bool bf_f405_time_read_ms(uint32_t *out);
void SysTick_Handler(void);

#endif /* BOBFLIGHT_HAL_STM32F4_TIMEBASE_H */
