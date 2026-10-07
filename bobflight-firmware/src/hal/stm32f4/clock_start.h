/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_F4_CLOCK_START_H
#define BOBFLIGHT_F4_CLOCK_START_H

#include <stdbool.h>
#include <stdint.h>
#include "clock_plan.h"

/* Explicit F4 hardware register identifiers required for clock bring-up. */
typedef enum {
    BF_F4_CLOCK_REG_RCC_CR = 0,
    BF_F4_CLOCK_REG_RCC_PLLCFGR,
    BF_F4_CLOCK_REG_RCC_CFGR,
    BF_F4_CLOCK_REG_RCC_APB1ENR,
    BF_F4_CLOCK_REG_PWR_CR,
    BF_F4_CLOCK_REG_PWR_CSR,
    BF_F4_CLOCK_REG_FLASH_ACR,
    BF_F4_CLOCK_REG_COUNT
} bf_f4_clock_reg_t;

/* Status codes for F4 cold-reset clock bring-up sequence. */
typedef enum {
    BF_F4_CLOCK_START_OK = 0,
    BF_F4_CLOCK_START_ERR_INVALID_PARAM,
    BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE,
    BF_F4_CLOCK_START_ERR_CALLBACK_FAILED,
    BF_F4_CLOCK_START_ERR_WRITE_CHECK_FAILED,
    BF_F4_CLOCK_START_ERR_FLASH_ACR_REJECT,
    BF_F4_CLOCK_START_ERR_HSE_TIMEOUT,
    BF_F4_CLOCK_START_ERR_PLL_TIMEOUT,
    BF_F4_CLOCK_START_ERR_VOS_TIMEOUT,
    BF_F4_CLOCK_START_ERR_SYSCLK_TIMEOUT,
    BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED,
    BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_WRITE_CHECK_FAILED
} bf_f4_clock_start_status_t;

/* Hardware register read/write callbacks for injected MMIO access. */
typedef bool (*bf_f4_clock_read_fn)(void *user_ctx, bf_f4_clock_reg_t reg, uint32_t *val);
typedef bool (*bf_f4_clock_write_fn)(void *user_ctx, bf_f4_clock_reg_t reg, uint32_t val);

/* Perform ordered cold-reset clock bring-up for STM32F405/F411.
 *
 * Rejects invalid parameters, unsupported plans, or unsafe starting states
 * (including non-HSI SW or SWS) before performing any register writes.
 * Reads and writes registers exclusively via injected callbacks.
 * Enforces per-stage finite polling budgets (counting read iterations).
 * On success (BF_F4_CLOCK_START_OK), populates *out_clocks and returns OK.
 * On failure, *out_clocks is left UNCHANGED and an error status is returned.
 */
bf_f4_clock_start_status_t bf_f4_clock_start(
    bf_f4_part_t part,
    uint32_t hse_hz,
    uint32_t vdd_mv,
    uint32_t poll_budget,
    bf_f4_clock_read_fn read_fn,
    bf_f4_clock_write_fn write_fn,
    void *user_ctx,
    bf_f4_clock_plan_t *out_clocks
);

/* Helper to convert a status code to a descriptive string. */
const char *bf_f4_clock_start_status_str(bf_f4_clock_start_status_t status);

/* Helper to query whether a failure occurred during or after attempting SYSCLK switch.
 * Returns true if failure happened during/after SYSCLK switch write (system clock state is uncertain),
 * or false if failure occurred prior to SYSCLK switch write attempt.
 *
 * IMPORTANT SAFETY NOTE:
 * Returning false DOES NOT prove or guarantee that the system clock remains safely on HSI!
 * A false return occurs on invalid parameters, initial register check/read failures (where starting
 * state was unsafe or unknown), or pre-switch configuration failures after partial register updates.
 * Callers must NOT assume safe HSI operation based solely on a false return value.
 */
bool bf_f4_clock_start_status_is_post_switch(bf_f4_clock_start_status_t status);

#endif /* BOBFLIGHT_F4_CLOCK_START_H */
