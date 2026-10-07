/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_F4_CLOCK_MMIO_H
#define BOBFLIGHT_F4_CLOCK_MMIO_H

#include <stddef.h>
#include "clock_start.h"

/**
 * STM32F405xG Direct Hardware MMIO Clock Bring-Up Interface.
 *
 * HARDWARE & SAFETY SPECIFICATION:
 * - Cold-Reset Exclusive Ownership: Assumes exclusive ownership of hardware clock
 *   initialization during cold reset. No concurrent clock modifications permitted.
 * - Failure Behavior: On failure, *out is left UNCHANGED and an error status is
 *   returned. A failure DOES NOT guarantee or promise a safe HSI state; callers must
 *   not assume safe HSI operation based solely on a failure return.
 * - Hardware Target: Component targeting STM32F405xG ONLY (BF_F4_COMPONENT_F405XG).
 *   Not supported on STM32F411xE.
 * - Qualification Status: Macro-compile guarded component; still NOT physically
 *   tested on real hardware. This macro is not a runtime chip/density probe.
 * - PRIMASK does not mask NMI/HardFault or prove exclusive clock ownership.
 */

/* Hardware register read callback for STM32F405 MMIO access.
 * Rejects non-NULL ctx, out-of-range reg, or NULL out before volatile access.
 * Returning true indicates access was issued, NOT bus fault containment.
 */
bool bf_f405_clock_mmio_read(void *ctx, bf_f4_clock_reg_t reg, uint32_t *out);

/* Hardware register write callback for STM32F405 MMIO access.
 * Rejects non-NULL ctx, out-of-range reg, or a PWR_CSR write before volatile access. PWR_CSR is read-only
 * in THIS adapter, not a claim that all hardware CSR bits are read-only.
 * Returning true indicates access was issued, NOT bus fault containment.
 */
bool bf_f405_clock_mmio_write(void *ctx, bf_f4_clock_reg_t reg, uint32_t value);

/* Perform direct MMIO cold-reset clock bring-up sequence for STM32F405xG.
 *
 * Validates board-provided parameters (hse_hz, vdd_mv, poll_budget, out) first.
 * Enforces PRIMASK interrupt mask guard (interrupts must be masked via PRIMASK)
 * before any MMIO access is performed.
 * On successful clock bring-up, executes architectural DSB/ISB memory/instruction
 * synchronization barriers and populates *out. On error, *out is left unchanged.
 */
bf_f4_clock_start_status_t bf_f405_clock_mmio_start(
    uint32_t hse_hz,
    uint32_t vdd_mv,
    uint32_t poll_budget,
    bf_f4_clock_plan_t *out
);

#endif /* BOBFLIGHT_F4_CLOCK_MMIO_H */
