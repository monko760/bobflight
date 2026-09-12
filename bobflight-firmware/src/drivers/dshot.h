/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Uni DShot600 TX. TIM+DMA from board_t motors[]; expands packet to a
 * bit-period CCR burst. Dummy IR binds zero channels and never bursts.
 *
 * Public encode helpers (packet CRC + bit high-time expand) are pure and
 * host-testable; they are clean-room from the public DShot protocol, not
 * Betaflight-derived.
 */
#ifndef BOBFLIGHT_DSHOT_H
#define BOBFLIGHT_DSHOT_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

#define DSHOT_MOTOR_COUNT 4

/* Bit-period CCR ticks (HAL maps bit_hz → ARR separately). */
#define DSHOT_BIT_TICKS   8u
#define DSHOT_BIT0_HIGH   3u  /* ~35% duty */
#define DSHOT_BIT1_HIGH   6u /* ~70% duty */
#define DSHOT_FRAME_BITS  16u
#define DSHOT_BURST_LEN   (DSHOT_FRAME_BITS + 4u) /* + idle low */

void dshot_init(void);
void motor_safe_idle(void);
void dshot_write(const float motor[DSHOT_MOTOR_COUNT]);
/** How many motor channels have a TIM handle (0 on dummy IR). */
unsigned dshot_bound_count(void);
bool dshot_is_healthy(void);

/** 11-bit throttle → 16-bit DShot packet (telem bit 0 + nibble XOR CRC). */
uint16_t dshot_encode_packet(uint16_t throttle11);
/** Expand packet MSB-first into CCR high-time buffer; out_n >= DSHOT_BURST_LEN. */
void dshot_expand_frame(uint16_t packet, uint16_t *out, size_t out_n);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_DSHOT_H */
