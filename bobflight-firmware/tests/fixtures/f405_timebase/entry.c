/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/* Model-only entry. These values are not a qualified board profile. */
#include <stdint.h>
#include "hal/stm32f4/clock_mmio.h"
#include "hal/stm32f4/timebase.h"
volatile uint32_t fixture_core_hz = 168000000u;
volatile uint32_t fixture_clock_status;
volatile uint32_t fixture_time_ready;
volatile uint32_t fixture_marker;
uint64_t fixture_us = UINT64_C(0x1122334455667788);
uint32_t fixture_ms = 0xaabbccddu;
bf_f4_clock_plan_t fixture_clocks;
__attribute__((noinline)) void fixture_return(void) { fixture_marker=3; __asm volatile("nop"); }
__attribute__((noinline)) void fixture_before_time(void) { fixture_marker=4; __asm volatile("nop"); }
__attribute__((noinline,noreturn)) void fixture_clock_failure(void)
{ fixture_marker=2;for(;;){__asm volatile("nop");} }
__attribute__((noinline,noreturn)) void fixture_ready(void)
{ fixture_marker=1;for(;;){__asm volatile("nop");} }
void bf_f4_component_entry(void)
{
    fixture_clock_status=bf_f405_clock_mmio_start(8000000u,3300u,8u,&fixture_clocks);
    if(fixture_clock_status!=BF_F4_CLOCK_START_OK)fixture_clock_failure();
    fixture_before_time();
    fixture_time_ready=bf_f405_time_init(fixture_core_hz);
    fixture_ready();
}
