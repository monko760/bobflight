/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "clock_start.h"

/* Bit masks for RCC_CR */
#define RCC_CR_HSION     (1u << 0)
#define RCC_CR_HSIRDY    (1u << 1)
#define RCC_CR_HSEON     (1u << 16)
#define RCC_CR_HSERDY    (1u << 17)
#define RCC_CR_HSEBYP    (1u << 18)
#define RCC_CR_PLLON     (1u << 24)
#define RCC_CR_PLLRDY    (1u << 25)
#define RCC_CR_PLLI2SON  (1u << 26)
#define RCC_CR_PLLI2SRDY (1u << 27)

/* Bit masks for RCC_CFGR */
#define RCC_CFGR_SW_MASK  (0x3u)
#define RCC_CFGR_SW_HSI   (0x0u)
#define RCC_CFGR_SW_PLL   (0x2u)
#define RCC_CFGR_SWS_MASK (0xCu)
#define RCC_CFGR_SWS_HSI  (0x0u)
#define RCC_CFGR_SWS_PLL  (0x8u)

/* Bit masks for RCC_APB1ENR */
#define RCC_APB1ENR_PWREN (1u << 28)

/* Bit masks for PWR_CSR */
#define PWR_CSR_VOSRDY    (1u << 14)

static bool read_reg(bf_f4_clock_read_fn read_fn, void *ctx,
                     bf_f4_clock_reg_t reg, uint32_t *val)
{
    if (!read_fn || !val) return false;
    return read_fn(ctx, reg, val);
}

static bool write_reg(bf_f4_clock_write_fn write_fn, void *ctx,
                      bf_f4_clock_reg_t reg, uint32_t val)
{
    if (!write_fn) return false;
    return write_fn(ctx, reg, val);
}

static bf_f4_clock_start_status_t update_reg_mask(
    bf_f4_clock_read_fn read_fn,
    bf_f4_clock_write_fn write_fn,
    void *ctx,
    bf_f4_clock_reg_t reg,
    uint32_t mask,
    uint32_t target_val,
    bool is_flash,
    bool is_sysclk_switch)
{
    uint32_t cur = 0;
    if (!read_reg(read_fn, ctx, reg, &cur)) {
        return BF_F4_CLOCK_START_ERR_CALLBACK_FAILED;
    }
    uint32_t new_val = (cur & ~mask) | (target_val & mask);
    if (!write_reg(write_fn, ctx, reg, new_val)) {
        return is_sysclk_switch ? BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED
                               : BF_F4_CLOCK_START_ERR_CALLBACK_FAILED;
    }
    uint32_t rb = 0;
    if (!read_reg(read_fn, ctx, reg, &rb)) {
        return is_sysclk_switch ? BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED
                               : BF_F4_CLOCK_START_ERR_CALLBACK_FAILED;
    }
    if ((rb & mask) != (target_val & mask)) {
        if (is_sysclk_switch) {
            return BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_WRITE_CHECK_FAILED;
        }
        return is_flash ? BF_F4_CLOCK_START_ERR_FLASH_ACR_REJECT
                        : BF_F4_CLOCK_START_ERR_WRITE_CHECK_FAILED;
    }
    return BF_F4_CLOCK_START_OK;
}

static bf_f4_clock_start_status_t poll_reg_bit(
    bf_f4_clock_read_fn read_fn,
    void *ctx,
    bf_f4_clock_reg_t reg,
    uint32_t mask,
    uint32_t expected,
    uint32_t budget,
    bf_f4_clock_start_status_t timeout_status,
    bf_f4_clock_start_status_t cb_fail_status)
{
    for (uint32_t i = 0; i < budget; i++) {
        uint32_t val = 0;
        if (!read_reg(read_fn, ctx, reg, &val)) {
            return cb_fail_status;
        }
        if ((val & mask) == expected) {
            return BF_F4_CLOCK_START_OK;
        }
    }
    return timeout_status;
}

bf_f4_clock_start_status_t bf_f4_clock_start(
    bf_f4_part_t part,
    uint32_t hse_hz,
    uint32_t vdd_mv,
    uint32_t poll_budget,
    bf_f4_clock_read_fn read_fn,
    bf_f4_clock_write_fn write_fn,
    void *user_ctx,
    bf_f4_clock_plan_t *out_clocks)
{
    if (!read_fn || !write_fn || !out_clocks || poll_budget == 0) {
        return BF_F4_CLOCK_START_ERR_INVALID_PARAM;
    }

    bf_f4_clock_register_plan_t reg_plan;
    if (!bf_f4_make_clock_register_plan(part, hse_hz, vdd_mv, &reg_plan)) {
        return BF_F4_CLOCK_START_ERR_INVALID_PARAM;
    }

    /* Reject unsafe starting state before performing any register writes. */
    uint32_t rcc_cr = 0;
    if (!read_reg(read_fn, user_ctx, BF_F4_CLOCK_REG_RCC_CR, &rcc_cr)) {
        return BF_F4_CLOCK_START_ERR_CALLBACK_FAILED;
    }

    /* Requirement: HSI active and ready, no PLL/PLLI2S active/ready, HSE crystal not bypass. */
    if ((rcc_cr & (RCC_CR_HSION | RCC_CR_HSIRDY)) != (RCC_CR_HSION | RCC_CR_HSIRDY)) {
        return BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE;
    }
    if (rcc_cr & (RCC_CR_PLLON | RCC_CR_PLLRDY | RCC_CR_PLLI2SON | RCC_CR_PLLI2SRDY)) {
        return BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE;
    }
    if (rcc_cr & RCC_CR_HSEBYP) {
        return BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE;
    }

    uint32_t rcc_cfgr = 0;
    if (!read_reg(read_fn, user_ctx, BF_F4_CLOCK_REG_RCC_CFGR, &rcc_cfgr)) {
        return BF_F4_CLOCK_START_ERR_CALLBACK_FAILED;
    }

    /* Requirement: SYSCLK target and status must both be HSI (SW == 00 and SWS == 00).
     * Rejects any live or pending system clock reconfiguration. */
    if ((rcc_cfgr & RCC_CFGR_SW_MASK) != RCC_CFGR_SW_HSI ||
        (rcc_cfgr & RCC_CFGR_SWS_MASK) != RCC_CFGR_SWS_HSI) {
        return BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE;
    }

    bf_f4_clock_start_status_t st;

    /* Sequence 1: PWR clock enable in RCC_APB1ENR */
    st = update_reg_mask(read_fn, write_fn, user_ctx,
                         BF_F4_CLOCK_REG_RCC_APB1ENR,
                         RCC_APB1ENR_PWREN, RCC_APB1ENR_PWREN, false, false);
    if (st != BF_F4_CLOCK_START_OK) return st;

    /* Sequence 2: Part-specific VOS in PWR_CR */
    st = update_reg_mask(read_fn, write_fn, user_ctx,
                         BF_F4_CLOCK_REG_PWR_CR,
                         reg_plan.pwr_cr.mask, reg_plan.pwr_cr.value, false, false);
    if (st != BF_F4_CLOCK_START_OK) return st;

    /* Sequence 3: Raise + readback FLASH latency before higher CPU rate */
    st = update_reg_mask(read_fn, write_fn, user_ctx,
                         BF_F4_CLOCK_REG_FLASH_ACR,
                         reg_plan.flash_acr.mask, reg_plan.flash_acr.value, true, false);
    if (st != BF_F4_CLOCK_START_OK) return st;

    /* Sequence 4: Program buses and PLL while off */
    st = update_reg_mask(read_fn, write_fn, user_ctx,
                         BF_F4_CLOCK_REG_RCC_CFGR,
                         reg_plan.cfgr.mask, reg_plan.cfgr.value, false, false);
    if (st != BF_F4_CLOCK_START_OK) return st;

    st = update_reg_mask(read_fn, write_fn, user_ctx,
                         BF_F4_CLOCK_REG_RCC_PLLCFGR,
                         reg_plan.pllcfgr.mask, reg_plan.pllcfgr.value, false, false);
    if (st != BF_F4_CLOCK_START_OK) return st;

    /* Sequence 5: HSE enable + wait HSERDY */
    st = update_reg_mask(read_fn, write_fn, user_ctx,
                         BF_F4_CLOCK_REG_RCC_CR,
                         RCC_CR_HSEON, RCC_CR_HSEON, false, false);
    if (st != BF_F4_CLOCK_START_OK) return st;

    st = poll_reg_bit(read_fn, user_ctx,
                      BF_F4_CLOCK_REG_RCC_CR,
                      RCC_CR_HSERDY, RCC_CR_HSERDY,
                      poll_budget, BF_F4_CLOCK_START_ERR_HSE_TIMEOUT,
                      BF_F4_CLOCK_START_ERR_CALLBACK_FAILED);
    if (st != BF_F4_CLOCK_START_OK) return st;

    /* Sequence 6: PLL enable + wait PLLRDY */
    st = update_reg_mask(read_fn, write_fn, user_ctx,
                         BF_F4_CLOCK_REG_RCC_CR,
                         RCC_CR_PLLON, RCC_CR_PLLON, false, false);
    if (st != BF_F4_CLOCK_START_OK) return st;

    st = poll_reg_bit(read_fn, user_ctx,
                      BF_F4_CLOCK_REG_RCC_CR,
                      RCC_CR_PLLRDY, RCC_CR_PLLRDY,
                      poll_budget, BF_F4_CLOCK_START_ERR_PLL_TIMEOUT,
                      BF_F4_CLOCK_START_ERR_CALLBACK_FAILED);
    if (st != BF_F4_CLOCK_START_OK) return st;

    /* Sequence 7: VOS readiness in correct phase (PWR_CSR VOSRDY bit 14) */
    st = poll_reg_bit(read_fn, user_ctx,
                      BF_F4_CLOCK_REG_PWR_CSR,
                      PWR_CSR_VOSRDY, PWR_CSR_VOSRDY,
                      poll_budget, BF_F4_CLOCK_START_ERR_VOS_TIMEOUT,
                      BF_F4_CLOCK_START_ERR_CALLBACK_FAILED);
    if (st != BF_F4_CLOCK_START_OK) return st;

    /* Sequence 8: SYSCLK switch + verify SWS in RCC_CFGR */
    st = update_reg_mask(read_fn, write_fn, user_ctx,
                         BF_F4_CLOCK_REG_RCC_CFGR,
                         RCC_CFGR_SW_MASK, RCC_CFGR_SW_PLL, false, true);
    if (st != BF_F4_CLOCK_START_OK) return st;

    st = poll_reg_bit(read_fn, user_ctx,
                      BF_F4_CLOCK_REG_RCC_CFGR,
                      RCC_CFGR_SWS_MASK, RCC_CFGR_SWS_PLL,
                      poll_budget, BF_F4_CLOCK_START_ERR_SYSCLK_TIMEOUT,
                      BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED);
    if (st != BF_F4_CLOCK_START_OK) return st;

    /* Success: populate out_clocks ONLY on complete success */
    *out_clocks = reg_plan.clocks;
    return BF_F4_CLOCK_START_OK;
}

const char *bf_f4_clock_start_status_str(bf_f4_clock_start_status_t status)
{
    switch (status) {
    case BF_F4_CLOCK_START_OK:
        return "OK";
    case BF_F4_CLOCK_START_ERR_INVALID_PARAM:
        return "Invalid parameter";
    case BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE:
        return "Unsafe initial register state";
    case BF_F4_CLOCK_START_ERR_CALLBACK_FAILED:
        return "Register read/write callback failed";
    case BF_F4_CLOCK_START_ERR_WRITE_CHECK_FAILED:
        return "Register write verification failed";
    case BF_F4_CLOCK_START_ERR_FLASH_ACR_REJECT:
        return "FLASH latency readback rejected";
    case BF_F4_CLOCK_START_ERR_HSE_TIMEOUT:
        return "HSE oscillator readiness timeout";
    case BF_F4_CLOCK_START_ERR_PLL_TIMEOUT:
        return "PLL lock readiness timeout";
    case BF_F4_CLOCK_START_ERR_VOS_TIMEOUT:
        return "Voltage scaling regulator readiness timeout";
    case BF_F4_CLOCK_START_ERR_SYSCLK_TIMEOUT:
        return "SYSCLK switch verification timeout";
    case BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED:
        return "SYSCLK switch callback failed";
    case BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_WRITE_CHECK_FAILED:
        return "SYSCLK switch write verification failed";
    default:
        return "Unknown error";
    }
}

bool bf_f4_clock_start_status_is_post_switch(bf_f4_clock_start_status_t status)
{
    return status == BF_F4_CLOCK_START_ERR_SYSCLK_TIMEOUT ||
           status == BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED ||
           status == BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_WRITE_CHECK_FAILED;
}
