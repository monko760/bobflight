/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "timebase.h"
#include "hal/cycle_clock.h"

#if !defined(__arm__) || !defined(__thumb__)
#error "timebase requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for timebase"
#endif

#if defined(BF_F4_COMPONENT_F411XE)
#error "BF_F4_COMPONENT_F411XE must NOT be defined for timebase"
#endif

#define DWT_CTRL     (*(volatile uint32_t *)0xE0001000u)
#define DWT_CYCCNT   (*(volatile uint32_t *)0xE0001004u)
#define DEMCR        (*(volatile uint32_t *)0xE000EDFCu)
#define SYST_CSR     (*(volatile uint32_t *)0xE000E010u)
#define SYST_RVR     (*(volatile uint32_t *)0xE000E014u)
#define SYST_CVR     (*(volatile uint32_t *)0xE000E018u)
#define SCB_SHPR3    (*(volatile uint32_t *)0xE000ED20u)
#define SCB_ICSR     (*(volatile uint32_t *)0xE000ED04u)

static cycle_clock_t s_clock;
static bool s_init_attempted = false;
static bool s_ready = false;
static uint32_t s_expected_rvr = 0u;

static inline uint32_t lock_irq(void)
{
    uint32_t primask;
    __asm__ __volatile__(
        "mrs %0, primask\n\t"
        "cpsid i"
        : "=r"(primask)
        :
        : "memory"
    );
    return primask;
}

static inline void unlock_irq(uint32_t primask)
{
    __asm__ __volatile__(
        "msr primask, %0"
        :
        : "r"(primask)
        : "memory"
    );
}

static inline bool is_nonmaskable_context(void)
{
    uint32_t ipsr;
    __asm__ __volatile__("mrs %0, ipsr" : "=r"(ipsr));
    return (ipsr == 2u || ipsr == 3u);
}

static inline bool check_hardware_health(void)
{
    if ((DEMCR & (1u << 24)) == 0u) {
        return false;
    }
    uint32_t dwt = DWT_CTRL;
    if ((dwt & 1u) == 0u || (dwt & (1u << 25)) != 0u) {
        return false;
    }
    if ((SYST_CSR & 7u) != 7u) {
        return false;
    }
    if (SYST_RVR != s_expected_rvr) {
        return false;
    }
    return true;
}

bool bf_f405_time_init(uint32_t core_hz)
{
    if (s_init_attempted) {
        return false;
    }

    if (core_hz < 1000000u || core_hz > 168000000u || (core_hz % 1000000u != 0u)) {
        return false;
    }

    uint32_t ipsr;
    __asm__ __volatile__("mrs %0, ipsr" : "=r"(ipsr));
    if (ipsr != 0u) {
        return false;
    }

    uint32_t primask;
    __asm__ __volatile__("mrs %0, primask" : "=r"(primask));
    if ((primask & 1u) == 0u) {
        return false;
    }

    if (SYST_CSR & 3u) {
        return false;
    }

    if (SCB_ICSR & (1u << 26)) {
        return false;
    }

    s_init_attempted = true;

    uint32_t demcr = DEMCR;
    DEMCR = demcr | (1u << 24);
    demcr = DEMCR;
    if ((demcr & (1u << 24)) == 0u) {
        return false;
    }

    uint32_t dwt_ctrl = DWT_CTRL;
    if (dwt_ctrl & (1u << 25)) {
        return false;
    }

    DWT_CTRL = dwt_ctrl | (1u << 0);
    dwt_ctrl = DWT_CTRL;
    if ((dwt_ctrl & (1u << 0)) == 0u) {
        return false;
    }

    __asm__ __volatile__("dsb\nisb" ::: "memory");

    uint32_t c1 = DWT_CYCCNT;
    for (int i = 0; i < 64; i++) {
        __asm__ __volatile__("nop");
    }
    uint32_t c2 = DWT_CYCCNT;
    if (c1 == c2) {
        return false;
    }

    __asm__ __volatile__("dsb\nisb" ::: "memory");

    if (!cycle_clock_init(&s_clock, core_hz, c2)) {
        return false;
    }

    uint32_t rvr_val = (core_hz / 1000u) - 1u;
    SYST_RVR = rvr_val;
    SYST_CVR = 0u;

    uint32_t shpr3 = SCB_SHPR3;
    SCB_SHPR3 = (shpr3 & 0x00FFFFFFu) | 0xF0000000u;

    SYST_CSR = 7u;

    if (SYST_RVR != rvr_val ||
        (SCB_SHPR3 & 0xFF000000u) != 0xF0000000u ||
        (SYST_CSR & 7u) != 7u) {
        SYST_CSR = 0u;
        return false;
    }

    s_expected_rvr = rvr_val;
    s_ready = true;
    return true;
}

bool bf_f405_time_read_us(uint64_t *out)
{
    if (!out || is_nonmaskable_context()) {
        return false;
    }

    uint32_t primask = lock_irq();
    if (!s_ready || !check_hardware_health()) {
        s_ready = false;
        unlock_irq(primask);
        return false;
    }

    uint32_t cyc = DWT_CYCCNT;
    uint64_t us = cycle_clock_update(&s_clock, cyc);
    unlock_irq(primask);

    *out = us;
    return true;
}

bool bf_f405_time_read_ms(uint32_t *out)
{
    if (!out || is_nonmaskable_context()) {
        return false;
    }

    uint32_t primask = lock_irq();
    if (!s_ready || !check_hardware_health()) {
        s_ready = false;
        unlock_irq(primask);
        return false;
    }

    uint32_t cyc = DWT_CYCCNT;
    uint64_t us = cycle_clock_update(&s_clock, cyc);
    unlock_irq(primask);

    *out = (uint32_t)(us / 1000u);
    return true;
}

void SysTick_Handler(void)
{
    if (is_nonmaskable_context()) {
        return;
    }

    uint32_t primask = lock_irq();
    if (!s_ready || !check_hardware_health()) {
        s_ready = false;
        unlock_irq(primask);
        return;
    }

    uint32_t cyc = DWT_CYCCNT;
    (void)cycle_clock_update(&s_clock, cyc);
    unlock_irq(primask);
}
