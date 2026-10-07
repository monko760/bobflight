/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "clock_mmio.h"

#if !defined(__arm__) || !defined(__thumb__)
#error "clock_mmio requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for clock_mmio"
#endif

#if defined(BF_F4_COMPONENT_F411XE)
#error "BF_F4_COMPONENT_F411XE must NOT be defined for clock_mmio"
#endif

bool bf_f405_clock_mmio_read(void *ctx, bf_f4_clock_reg_t reg, uint32_t *out)
{
    if (ctx != NULL || !out) {
        return false;
    }
    if ((unsigned int)reg >= (unsigned int)BF_F4_CLOCK_REG_COUNT) {
        return false;
    }

    uintptr_t addr;
    switch (reg) {
    case BF_F4_CLOCK_REG_RCC_CR:
        addr = 0x40023800u;
        break;
    case BF_F4_CLOCK_REG_RCC_PLLCFGR:
        addr = 0x40023804u;
        break;
    case BF_F4_CLOCK_REG_RCC_CFGR:
        addr = 0x40023808u;
        break;
    case BF_F4_CLOCK_REG_RCC_APB1ENR:
        addr = 0x40023840u;
        break;
    case BF_F4_CLOCK_REG_PWR_CR:
        addr = 0x40007000u;
        break;
    case BF_F4_CLOCK_REG_PWR_CSR:
        addr = 0x40007004u;
        break;
    case BF_F4_CLOCK_REG_FLASH_ACR:
        addr = 0x40023c00u;
        break;
    default:
        return false;
    }

    __asm__ __volatile__("" ::: "memory");
    *out = *(volatile uint32_t *)addr;
    __asm__ __volatile__("" ::: "memory");
    return true;
}

bool bf_f405_clock_mmio_write(void *ctx, bf_f4_clock_reg_t reg, uint32_t value)
{
    if (ctx != NULL) {
        return false;
    }
    if ((unsigned int)reg >= (unsigned int)BF_F4_CLOCK_REG_COUNT) {
        return false;
    }
    if (reg == BF_F4_CLOCK_REG_PWR_CSR) {
        return false;
    }

    uintptr_t addr;
    switch (reg) {
    case BF_F4_CLOCK_REG_RCC_CR:
        addr = 0x40023800u;
        break;
    case BF_F4_CLOCK_REG_RCC_PLLCFGR:
        addr = 0x40023804u;
        break;
    case BF_F4_CLOCK_REG_RCC_CFGR:
        addr = 0x40023808u;
        break;
    case BF_F4_CLOCK_REG_RCC_APB1ENR:
        addr = 0x40023840u;
        break;
    case BF_F4_CLOCK_REG_PWR_CR:
        addr = 0x40007000u;
        break;
    case BF_F4_CLOCK_REG_FLASH_ACR:
        addr = 0x40023c00u;
        break;
    default:
        return false;
    }

    __asm__ __volatile__("" ::: "memory");
    *(volatile uint32_t *)addr = value;
    __asm__ __volatile__("" ::: "memory");
    return true;
}

bf_f4_clock_start_status_t bf_f405_clock_mmio_start(
    uint32_t hse_hz,
    uint32_t vdd_mv,
    uint32_t poll_budget,
    bf_f4_clock_plan_t *out)
{
    if (!out || poll_budget == 0) {
        return BF_F4_CLOCK_START_ERR_INVALID_PARAM;
    }

    bf_f4_clock_plan_t dummy;
    if (!bf_f4_make_clock_plan(BF_F4_PART_F405, hse_hz, vdd_mv, &dummy)) {
        return BF_F4_CLOCK_START_ERR_INVALID_PARAM;
    }

    uint32_t primask = 0;
    __asm__ __volatile__("mrs %0, primask" : "=r"(primask));
    if ((primask & 1u) == 0u) {
        return BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE;
    }

    bf_f4_clock_start_status_t status = bf_f4_clock_start(
        BF_F4_PART_F405,
        hse_hz,
        vdd_mv,
        poll_budget,
        bf_f405_clock_mmio_read,
        bf_f405_clock_mmio_write,
        NULL,
        out
    );

    if (status == BF_F4_CLOCK_START_OK) {
        /* DSB/ISB architectural barriers ensure memory writes complete and instruction
         * pipeline is flushed following SYSCLK frequency and FLASH latency updates. */
        __asm__ __volatile__("dsb\nisb" ::: "memory");
    }

    return status;
}
