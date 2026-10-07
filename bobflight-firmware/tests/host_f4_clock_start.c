/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "hal/stm32f4/clock_start.h"

#define MAX_WRITES 32

typedef struct {
    bf_f4_clock_reg_t reg;
    uint32_t val;
} write_log_entry_t;

typedef struct {
    uint32_t regs[BF_F4_CLOCK_REG_COUNT];
    write_log_entry_t writes[MAX_WRITES];
    uint32_t write_count;

    /* Callback injection flags */
    bool fail_read_reg[BF_F4_CLOCK_REG_COUNT];
    bool fail_write_reg[BF_F4_CLOCK_REG_COUNT];
    uint32_t fail_read_on_step; /* Fail read on specific global call count if > 0 */
    uint32_t read_call_count;

    /* Hardware simulation behaviors */
    bool flash_reject_latency;
    bool hse_never_ready;
    bool pll_never_ready;
    bool vos_never_ready;
    bool sysclk_never_switch;

    /* Specific SYSCLK switch fault injection flags */
    bool fail_sysclk_switch_write;
    bool fail_sysclk_switch_write_side_effect;
    bool fail_sysclk_switch_readback;
    bool sysclk_switch_readback_mismatch;
    bool fail_sysclk_sws_poll_read;

    uint32_t hse_poll_count;
    uint32_t pll_poll_count;
    uint32_t vos_poll_count;
    uint32_t sysclk_poll_count;
    uint32_t rcc_cfgr_post_switch_read_count;
} mock_ctx_t;

static void mock_reset(mock_ctx_t *ctx)
{
    memset(ctx, 0, sizeof(*ctx));
    /* Cold-reset state for RCC_CR: HSION | HSIRDY */
    ctx->regs[BF_F4_CLOCK_REG_RCC_CR] = 0x00000003u;
    ctx->regs[BF_F4_CLOCK_REG_RCC_CFGR] = 0x00000000u;
    ctx->regs[BF_F4_CLOCK_REG_RCC_APB1ENR] = 0x00000000u;
    ctx->regs[BF_F4_CLOCK_REG_PWR_CR] = 0x00000000u;
    ctx->regs[BF_F4_CLOCK_REG_PWR_CSR] = 0x00000000u;
    ctx->regs[BF_F4_CLOCK_REG_FLASH_ACR] = 0x00000000u;
}

static bool mock_read_cb(void *user_ctx, bf_f4_clock_reg_t reg, uint32_t *val)
{
    mock_ctx_t *m = (mock_ctx_t *)user_ctx;
    if (!m || reg >= BF_F4_CLOCK_REG_COUNT || !val) return false;

    m->read_call_count++;
    if (m->fail_read_reg[reg]) return false;
    if (m->fail_read_on_step > 0 && m->read_call_count == m->fail_read_on_step) {
        return false;
    }

    if (reg == BF_F4_CLOCK_REG_RCC_CFGR) {
        /* Check if we should simulate read failure during switch readback or SWS polling */
        if ((m->regs[BF_F4_CLOCK_REG_RCC_CFGR] & 0x3u) == 0x2u) {
            m->rcc_cfgr_post_switch_read_count++;
            if (m->fail_sysclk_switch_readback && m->rcc_cfgr_post_switch_read_count == 1) {
                return false;
            }
            if (m->fail_sysclk_sws_poll_read && m->rcc_cfgr_post_switch_read_count >= 2) {
                return false;
            }
        }
    }

    /* Simulate polling updates */
    if (reg == BF_F4_CLOCK_REG_RCC_CR) {
        if ((m->regs[BF_F4_CLOCK_REG_RCC_CR] & (1u << 16)) && !m->hse_never_ready) {
            m->regs[BF_F4_CLOCK_REG_RCC_CR] |= (1u << 17); /* HSERDY */
            m->hse_poll_count++;
        }
        if ((m->regs[BF_F4_CLOCK_REG_RCC_CR] & (1u << 24)) && !m->pll_never_ready) {
            m->regs[BF_F4_CLOCK_REG_RCC_CR] |= (1u << 25); /* PLLRDY */
            m->pll_poll_count++;
        }
    } else if (reg == BF_F4_CLOCK_REG_PWR_CSR) {
        if (!m->vos_never_ready) {
            m->regs[BF_F4_CLOCK_REG_PWR_CSR] |= (1u << 14); /* VOSRDY */
            m->vos_poll_count++;
        }
    } else if (reg == BF_F4_CLOCK_REG_RCC_CFGR) {
        if ((m->regs[BF_F4_CLOCK_REG_RCC_CFGR] & 0x3u) == 0x2u && !m->sysclk_never_switch) {
            m->regs[BF_F4_CLOCK_REG_RCC_CFGR] =
                (m->regs[BF_F4_CLOCK_REG_RCC_CFGR] & ~0xCu) | 0x8u; /* SWS = PLL */
            m->sysclk_poll_count++;
        }
    }

    *val = m->regs[reg];
    return true;
}

static bool mock_write_cb(void *user_ctx, bf_f4_clock_reg_t reg, uint32_t val)
{
    mock_ctx_t *m = (mock_ctx_t *)user_ctx;
    if (!m || reg >= BF_F4_CLOCK_REG_COUNT) return false;
    if (m->fail_write_reg[reg]) return false;

    /* Detect SYSCLK switch write (write to RCC_CFGR setting SW = 10) */
    if (reg == BF_F4_CLOCK_REG_RCC_CFGR && (val & 0x3u) == 0x2u) {
        if (m->fail_sysclk_switch_write) {
            if (m->fail_sysclk_switch_write_side_effect) {
                m->regs[reg] = (m->regs[reg] & ~0x3u) | 0x2u; /* Side effect before failure */
            }
            return false;
        }
        if (m->sysclk_switch_readback_mismatch) {
            m->regs[reg] = (val & ~0x3u); /* Ignore SW update, leaving SW = 00 */
            if (m->write_count < MAX_WRITES) {
                m->writes[m->write_count].reg = reg;
                m->writes[m->write_count].val = val;
                m->write_count++;
            }
            return true;
        }
    }

    if (m->write_count < MAX_WRITES) {
        m->writes[m->write_count].reg = reg;
        m->writes[m->write_count].val = val;
        m->write_count++;
    }

    if (reg == BF_F4_CLOCK_REG_FLASH_ACR && m->flash_reject_latency) {
        /* Reject write: latency bits 2:0 remain 0 */
        m->regs[reg] = (val & ~0x7u);
    } else {
        m->regs[reg] = val;
    }
    return true;
}

static void test_f405_success(void)
{
    mock_ctx_t m;
    mock_reset(&m);

    /* Preserve extra noisy bits in fake registers */
    m.regs[BF_F4_CLOCK_REG_RCC_CFGR] |= 0x00010000u;
    m.regs[BF_F4_CLOCK_REG_FLASH_ACR] |= 0x00000700u;

    bf_f4_clock_plan_t plan;
    memset(&plan, 0xA5, sizeof(plan));

    bf_f4_clock_start_status_t st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 20u,
        mock_read_cb, mock_write_cb, &m, &plan
    );

    assert(st == BF_F4_CLOCK_START_OK);
    assert(plan.sysclk_hz == 168000000u);
    assert(plan.hclk_hz == 168000000u);
    assert(plan.usb_hz == 48000000u);
    assert(plan.apb1_hz == 42000000u);
    assert(plan.apb2_hz == 84000000u);
    assert(plan.apb1_timer_hz == 84000000u);
    assert(plan.apb2_timer_hz == 168000000u);
    assert(plan.flash_wait_states == 5);
    assert(plan.voltage_scale == 1);

    /* Verify register writes in order */
    assert(m.write_count >= 8);
    assert(m.writes[0].reg == BF_F4_CLOCK_REG_RCC_APB1ENR);
    assert(m.writes[0].val & (1u << 28));
    assert(m.writes[1].reg == BF_F4_CLOCK_REG_PWR_CR);
    assert((m.writes[1].val & 0x4000u) == 0x4000u);
    assert(m.writes[2].reg == BF_F4_CLOCK_REG_FLASH_ACR);
    assert((m.writes[2].val & 0x7u) == 5u);
    assert(m.writes[2].val & 0x00000700u); /* Mask preservation check */
    assert(m.writes[3].reg == BF_F4_CLOCK_REG_RCC_CFGR);
    assert((m.writes[3].val & 0x0000fcf0u) == 0x9400u);
    assert(m.writes[4].reg == BF_F4_CLOCK_REG_RCC_PLLCFGR);
    assert(m.writes[5].reg == BF_F4_CLOCK_REG_RCC_CR);
    assert(m.writes[5].val & (1u << 16)); /* HSEON */
    assert(m.writes[6].reg == BF_F4_CLOCK_REG_RCC_CR);
    assert(m.writes[6].val & (1u << 24)); /* PLLON */
    assert(m.writes[7].reg == BF_F4_CLOCK_REG_RCC_CFGR);
    assert((m.writes[7].val & 0x3u) == 0x2u); /* SW = PLL */

    /* Verify final SWS status bit is set to PLL */
    assert((m.regs[BF_F4_CLOCK_REG_RCC_CFGR] & 0xCu) == 0x8u);
}

static void test_f411_success(void)
{
    mock_ctx_t m;
    mock_reset(&m);

    bf_f4_clock_plan_t plan;
    memset(&plan, 0xA5, sizeof(plan));

    bf_f4_clock_start_status_t st = bf_f4_clock_start(
        BF_F4_PART_F411, 8000000u, 3300u, 20u,
        mock_read_cb, mock_write_cb, &m, &plan
    );

    assert(st == BF_F4_CLOCK_START_OK);
    assert(plan.sysclk_hz == 96000000u);
    assert(plan.hclk_hz == 96000000u);
    assert(plan.usb_hz == 48000000u);
    assert(plan.apb1_hz == 48000000u);
    assert(plan.apb2_hz == 96000000u);
    assert(plan.apb1_timer_hz == 96000000u);
    assert(plan.apb2_timer_hz == 96000000u);
    assert(plan.flash_wait_states == 3);
    assert(plan.voltage_scale == 1);

    /* Verify F411 PWR_CR Scale 1 encoding (bits 15:14 = 0b11 -> 0xc000) */
    assert(m.writes[1].reg == BF_F4_CLOCK_REG_PWR_CR);
    assert((m.writes[1].val & 0xc000u) == 0xc000u);
    assert((m.writes[2].val & 0x7u) == 3u); /* FLASH latency 3 */
}

static void test_invalid_parameters(void)
{
    mock_ctx_t m;
    mock_reset(&m);
    bf_f4_clock_plan_t sentinel;
    memset(&sentinel, 0xA5, sizeof(sentinel));
    bf_f4_clock_plan_t plan = sentinel;

    /* Null callbacks / outputs */
    assert(bf_f4_clock_start(BF_F4_PART_F405, 8000000u, 3300u, 10u, NULL, mock_write_cb, &m, &plan) == BF_F4_CLOCK_START_ERR_INVALID_PARAM);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(m.write_count == 0);

    assert(bf_f4_clock_start(BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, NULL, &m, &plan) == BF_F4_CLOCK_START_ERR_INVALID_PARAM);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(m.write_count == 0);

    assert(bf_f4_clock_start(BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, NULL) == BF_F4_CLOCK_START_ERR_INVALID_PARAM);

    assert(bf_f4_clock_start(BF_F4_PART_F405, 8000000u, 3300u, 0u, mock_read_cb, mock_write_cb, &m, &plan) == BF_F4_CLOCK_START_ERR_INVALID_PARAM);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(m.write_count == 0);

    /* Invalid clock plan parameters */
    assert(bf_f4_clock_start(BF_F4_PART_F405, 3000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan) == BF_F4_CLOCK_START_ERR_INVALID_PARAM);
    assert(bf_f4_clock_start(BF_F4_PART_F405, 8000000u, 1800u, 10u, mock_read_cb, mock_write_cb, &m, &plan) == BF_F4_CLOCK_START_ERR_INVALID_PARAM);
    assert(bf_f4_clock_start((bf_f4_part_t)999, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan) == BF_F4_CLOCK_START_ERR_INVALID_PARAM);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(m.write_count == 0);
}

static void test_unsafe_initial_states(void)
{
    mock_ctx_t m;
    bf_f4_clock_plan_t sentinel, plan;
    memset(&sentinel, 0x5A, sizeof(sentinel));

    /* Case 1: HSI not ready */
    mock_reset(&m);
    m.regs[BF_F4_CLOCK_REG_RCC_CR] = 0x00000001u; /* HSION=1, HSIRDY=0 */
    plan = sentinel;
    bf_f4_clock_start_status_t st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(m.write_count == 0);
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* Case 2: PLLON already active */
    mock_reset(&m);
    m.regs[BF_F4_CLOCK_REG_RCC_CR] |= (1u << 24);
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(m.write_count == 0);
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* Case 3: PLLRDY already set */
    mock_reset(&m);
    m.regs[BF_F4_CLOCK_REG_RCC_CR] |= (1u << 25);
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE);
    assert(m.write_count == 0);
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* Case 4: PLLI2SON set */
    mock_reset(&m);
    m.regs[BF_F4_CLOCK_REG_RCC_CR] |= (1u << 26);
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE);
    assert(m.write_count == 0);
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* Case 5: HSEBYP set */
    mock_reset(&m);
    m.regs[BF_F4_CLOCK_REG_RCC_CR] |= (1u << 18);
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE);
    assert(m.write_count == 0);
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* Case 6: SWS not HSI (e.g. SWS = 10 (PLL)) */
    mock_reset(&m);
    m.regs[BF_F4_CLOCK_REG_RCC_CFGR] = 0x00000008u; /* SWS = 10 */
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(m.write_count == 0);
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* Case 7: SW pending variants (SW != 00 while SWS == 00) */
    uint32_t sw_pending_vals[] = {0x1u, 0x2u, 0x3u};
    for (size_t i = 0; i < sizeof(sw_pending_vals)/sizeof(sw_pending_vals[0]); i++) {
        mock_reset(&m);
        m.regs[BF_F4_CLOCK_REG_RCC_CFGR] = sw_pending_vals[i]; /* SW set, SWS = 0 */
        plan = sentinel;
        st = bf_f4_clock_start(
            BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
        assert(st == BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE);
        assert(!memcmp(&sentinel, &plan, sizeof(plan)));
        assert(m.write_count == 0);
        assert(!bf_f4_clock_start_status_is_post_switch(st));
    }
}

static void test_flash_latency_rejection(void)
{
    mock_ctx_t m;
    mock_reset(&m);
    m.flash_reject_latency = true;

    bf_f4_clock_plan_t sentinel, plan;
    memset(&sentinel, 0xA5, sizeof(sentinel));
    plan = sentinel;

    bf_f4_clock_start_status_t st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u,
        mock_read_cb, mock_write_cb, &m, &plan
    );

    assert(st == BF_F4_CLOCK_START_ERR_FLASH_ACR_REJECT);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(!bf_f4_clock_start_status_is_post_switch(st));
}

static void test_timeouts(void)
{
    mock_ctx_t m;
    bf_f4_clock_plan_t sentinel, plan;
    memset(&sentinel, 0xA5, sizeof(sentinel));

    /* HSE timeout */
    mock_reset(&m);
    m.hse_never_ready = true;
    plan = sentinel;
    bf_f4_clock_start_status_t st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 7u,
        mock_read_cb, mock_write_cb, &m, &plan
    );
    assert(st == BF_F4_CLOCK_START_ERR_HSE_TIMEOUT);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(m.hse_poll_count == 0); /* HSERDY never became set */
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* PLL timeout */
    mock_reset(&m);
    m.pll_never_ready = true;
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 7u,
        mock_read_cb, mock_write_cb, &m, &plan
    );
    assert(st == BF_F4_CLOCK_START_ERR_PLL_TIMEOUT);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* VOS timeout */
    mock_reset(&m);
    m.vos_never_ready = true;
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 7u,
        mock_read_cb, mock_write_cb, &m, &plan
    );
    assert(st == BF_F4_CLOCK_START_ERR_VOS_TIMEOUT);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* SYSCLK switch timeout (UNCERTAIN POST-SWITCH FAILURE) */
    mock_reset(&m);
    m.sysclk_never_switch = true;
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 7u,
        mock_read_cb, mock_write_cb, &m, &plan
    );
    assert(st == BF_F4_CLOCK_START_ERR_SYSCLK_TIMEOUT);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(bf_f4_clock_start_status_is_post_switch(st));
}

static void test_callback_failures(void)
{
    mock_ctx_t m;
    bf_f4_clock_plan_t sentinel, plan;
    memset(&sentinel, 0xA5, sizeof(sentinel));

    /* Read callback fails */
    mock_reset(&m);
    m.fail_read_reg[BF_F4_CLOCK_REG_RCC_CR] = true;
    plan = sentinel;
    bf_f4_clock_start_status_t st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_CALLBACK_FAILED);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(!bf_f4_clock_start_status_is_post_switch(st));

    /* Write callback fails */
    mock_reset(&m);
    m.fail_write_reg[BF_F4_CLOCK_REG_RCC_APB1ENR] = true;
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_CALLBACK_FAILED);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(!bf_f4_clock_start_status_is_post_switch(st));
}

static void test_post_switch_fault_injections(void)
{
    mock_ctx_t m;
    bf_f4_clock_plan_t sentinel, plan;
    memset(&sentinel, 0xA5, sizeof(sentinel));

    /* 1. Switch write failure WITHOUT side effect */
    mock_reset(&m);
    m.fail_sysclk_switch_write = true;
    m.fail_sysclk_switch_write_side_effect = false;
    plan = sentinel;
    bf_f4_clock_start_status_t st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(bf_f4_clock_start_status_is_post_switch(st));

    /* 2. Switch write failure WITH side effect (register partially modified before callback returned false) */
    mock_reset(&m);
    m.fail_sysclk_switch_write = true;
    m.fail_sysclk_switch_write_side_effect = true;
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(bf_f4_clock_start_status_is_post_switch(st));

    /* 3. Readback read failure after switch write */
    mock_reset(&m);
    m.fail_sysclk_switch_readback = true;
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(bf_f4_clock_start_status_is_post_switch(st));

    /* 4. Readback mismatch after switch write (SW bit write failed to stick) */
    mock_reset(&m);
    m.sysclk_switch_readback_mismatch = true;
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_WRITE_CHECK_FAILED);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(bf_f4_clock_start_status_is_post_switch(st));

    /* 5. SWS poll read callback failure */
    mock_reset(&m);
    m.fail_sysclk_sws_poll_read = true;
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(bf_f4_clock_start_status_is_post_switch(st));

    /* 6. SWS poll timeout */
    mock_reset(&m);
    m.sysclk_never_switch = true;
    plan = sentinel;
    st = bf_f4_clock_start(
        BF_F4_PART_F405, 8000000u, 3300u, 10u, mock_read_cb, mock_write_cb, &m, &plan);
    assert(st == BF_F4_CLOCK_START_ERR_SYSCLK_TIMEOUT);
    assert(!memcmp(&sentinel, &plan, sizeof(plan)));
    assert(bf_f4_clock_start_status_is_post_switch(st));
}

static void test_helpers(void)
{
    for (int s = 0; s <= BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_WRITE_CHECK_FAILED; s++) {
        const char *str = bf_f4_clock_start_status_str((bf_f4_clock_start_status_t)s);
        assert(str && strlen(str) > 0);
    }
    assert(!strcmp(bf_f4_clock_start_status_str((bf_f4_clock_start_status_t)999), "Unknown error"));

    /* Verify post-switch helper return values */
    assert(bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_SYSCLK_TIMEOUT));
    assert(bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_CALLBACK_FAILED));
    assert(bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_SYSCLK_SWITCH_WRITE_CHECK_FAILED));

    assert(!bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_OK));
    assert(!bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_INVALID_PARAM));
    assert(!bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_UNSAFE_INITIAL_STATE));
    assert(!bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_CALLBACK_FAILED));
    assert(!bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_WRITE_CHECK_FAILED));
    assert(!bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_FLASH_ACR_REJECT));
    assert(!bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_HSE_TIMEOUT));
    assert(!bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_PLL_TIMEOUT));
    assert(!bf_f4_clock_start_status_is_post_switch(BF_F4_CLOCK_START_ERR_VOS_TIMEOUT));
}

int main(void)
{
    test_f405_success();
    test_f411_success();
    test_invalid_parameters();
    test_unsafe_initial_states();
    test_flash_latency_rejection();
    test_timeouts();
    test_callback_failures();
    test_post_switch_fault_injections();
    test_helpers();

    puts("PASS host_f4_clock_start: cold-reset clock bring-up, sequence validation, mask preservation, read/write callbacks, readiness timeouts, flash rejection, unsafe initial state rejections, post-switch fault injection regression");
    return 0;
}
