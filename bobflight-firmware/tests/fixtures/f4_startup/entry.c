/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include <stdint.h>
volatile uint32_t fixture_data = 0x1234abcd;
volatile uint32_t fixture_bss;
volatile uint32_t fixture_noinit __attribute__((section(".noinit")));
volatile uint32_t fixture_dma[8] __attribute__((section(".dma_bss")));
void bf_f4_component_entry(void) {
    for (;;) { fixture_bss = fixture_data + fixture_noinit + fixture_dma[0]; }
}
