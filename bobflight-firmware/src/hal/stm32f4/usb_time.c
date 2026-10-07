/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "usb_time.h"
#include "timebase.h"
#include <stddef.h>

#if !defined(__arm__) || !defined(__thumb__)
#error "usb_time requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for usb_time"
#endif

#if defined(BF_F4_COMPONENT_F411XE)
#error "BF_F4_COMPONENT_F411XE must NOT be defined for usb_time"
#endif

uint32_t SystemCoreClock = 0u;
volatile uint32_t bf_f405_usb_time_fault_reason = 0u;

static bool s_bound = false;

__attribute__((weak, noreturn)) void bf_f405_usb_time_fault(uint32_t reason)
{
    __asm__ __volatile__("cpsid i" ::: "memory");
    bf_f405_usb_time_fault_reason = reason;
    for (;;) {
        __asm__ __volatile__("nop");
    }
}

bool bf_f405_usb_time_bind(const bf_f4_clock_plan_t *clocks)
{
    if (s_bound) {
        return false;
    }

    uint32_t ipsr = 0u;
    __asm__ __volatile__("mrs %0, ipsr" : "=r"(ipsr));
    if (ipsr != 0u) {
        return false;
    }

    uint32_t primask = 0u;
    __asm__ __volatile__("mrs %0, primask" : "=r"(primask));
    if ((primask & 1u) == 0u) {
        return false;
    }

    if (!clocks) {
        return false;
    }

    if (clocks->hclk_hz != 168000000u ||
        clocks->sysclk_hz != 168000000u ||
        clocks->usb_hz != 48000000u) {
        return false;
    }

    uint64_t dummy_us = 0u;
    if (!bf_f405_time_read_us(&dummy_us)) {
        return false;
    }

    SystemCoreClock = 168000000u;
    s_bound = true;
    return true;
}

bool bf_f405_usb_wait_us(uint32_t delay_us, uint32_t poll_budget)
{
    if (!s_bound) {
        return false;
    }

    uint32_t ipsr = 0u;
    __asm__ __volatile__("mrs %0, ipsr" : "=r"(ipsr));
    if (ipsr != 0u) {
        return false;
    }

    if (delay_us > 100000u) {
        return false;
    }

    if (poll_budget < 1u || poll_budget > 1000000u) {
        return false;
    }

    uint64_t start_us = 0u;
    if (!bf_f405_time_read_us(&start_us)) {
        return false;
    }

    if (delay_us == 0u) {
        return true;
    }

    for (uint32_t i = 0u; i < poll_budget; i++) {
        uint64_t now_us = 0u;
        if (!bf_f405_time_read_us(&now_us)) {
            return false;
        }
        if ((now_us - start_us) >= (uint64_t)delay_us) {
            return true;
        }
    }

    return false;
}

uint32_t tusb_time_millis_api(void)
{
    if (!s_bound) {
        bf_f405_usb_time_fault(1u);
    }

    uint32_t ms = 0u;
    if (!bf_f405_time_read_ms(&ms)) {
        bf_f405_usb_time_fault(1u);
    }

    return ms;
}

void tusb_time_delay_ms_api(uint32_t ms)
{
    if (ms > 100u) {
        bf_f405_usb_time_fault(2u);
    }

    if (!bf_f405_usb_wait_us(ms * 1000u, 1000000u)) {
        bf_f405_usb_time_fault(3u);
    }
}
