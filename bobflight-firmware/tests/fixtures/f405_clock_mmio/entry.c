/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/* Simulation fixture only. These oscillator/supply values are NOT board defaults. */
#include <stddef.h>
#include <stdint.h>
#include "hal/stm32f4/clock_mmio.h"
volatile uint32_t fixture_hse_hz = 8000000u;
volatile uint32_t fixture_vdd_mv = 3300u;
volatile uint32_t fixture_budget = 8u;
volatile uint32_t fixture_null_output;
volatile uint32_t fixture_probe_only;
volatile uint32_t fixture_probe_failures;
volatile uint32_t fixture_probe_result;
volatile uint32_t fixture_status;
volatile uint32_t fixture_marker;
volatile uint32_t fixture_noinit __attribute__((section(".noinit")));
volatile uint32_t fixture_dma[8] __attribute__((section(".dma_bss")));
bf_f4_clock_plan_t fixture_clocks = {.hse_hz = 0x11223344u, .sysclk_hz = 0x55667788u};

__attribute__((noinline,noreturn)) void fixture_success(void)
{ fixture_marker = 1; for (;;) { __asm volatile("nop"); } }
__attribute__((noinline,noreturn)) void fixture_failure(void)
{ fixture_marker = 2; for (;;) { __asm volatile("nop"); } }
__attribute__((noinline,noreturn)) void fixture_probe_done(void)
{ fixture_marker = 3; for (;;) { __asm volatile("nop"); } }

void bf_f4_component_entry(void)
{
    if (fixture_probe_only) {
        uint32_t value = 0xcafebabeu;
        fixture_probe_failures += bf_f405_clock_mmio_read(NULL, (bf_f4_clock_reg_t)-1, &value);
        fixture_probe_failures += bf_f405_clock_mmio_read(NULL, BF_F4_CLOCK_REG_COUNT, &value);
        fixture_probe_failures += bf_f405_clock_mmio_read((void *)1, BF_F4_CLOCK_REG_RCC_CR, &value);
        fixture_probe_failures += bf_f405_clock_mmio_read(NULL, BF_F4_CLOCK_REG_RCC_CR, NULL);
        fixture_probe_failures += bf_f405_clock_mmio_write(NULL, (bf_f4_clock_reg_t)-1, 0);
        fixture_probe_failures += bf_f405_clock_mmio_write(NULL, BF_F4_CLOCK_REG_COUNT, 0);
        fixture_probe_failures += bf_f405_clock_mmio_write((void *)1, BF_F4_CLOCK_REG_RCC_CR, 0);
        fixture_probe_failures += bf_f405_clock_mmio_write(NULL, BF_F4_CLOCK_REG_PWR_CSR, 0);
        fixture_probe_result = value;
        fixture_probe_done();
    }
    fixture_status = bf_f405_clock_mmio_start(fixture_hse_hz, fixture_vdd_mv,
        fixture_budget, fixture_null_output ? NULL : &fixture_clocks);
    if (fixture_status == BF_F4_CLOCK_START_OK) fixture_success();
    /* Failure never calls the successful next stage or uses requested frequencies. */
    fixture_failure();
}
