/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Uni DShot TX, selectable 300/600 kbps (default 300). TIM+DMA from
 * board_t motors[]; expands packet to a bit-period CCR burst. Dummy IR
 * binds zero channels and never bursts.
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
#include "drivers/dshot_telem.h"

#ifdef __cplusplus
extern "C" {
#endif

#define DSHOT_MOTOR_COUNT 4

/* Bit-period CCR ticks (HAL maps bit_hz → ARR separately). */
#define DSHOT_BIT_TICKS   8u
#define DSHOT_BIT0_HIGH   3u  /* 37.5% high - DShot logical 0 */
#define DSHOT_BIT1_HIGH   6u  /* 75% high - DShot logical 1 */
#define DSHOT_FRAME_BITS  16u
#define DSHOT_BURST_LEN   (DSHOT_FRAME_BITS + 4u) /* + idle low */

void dshot_init(void);
void motor_safe_idle(void);

/* Bit-rate selection: DSHOT_KBPS_300 (default, bring-up) or DSHOT_KBPS_600.
 * Switching is refused while armed or bench output is active/pending.
 * Stop bench tests and wait for motors to stop before changing rate. */
#define DSHOT_KBPS_300 300u
#define DSHOT_KBPS_600 600u
bool dshot_set_speed_kbps(unsigned kbps);
unsigned dshot_speed_kbps(void);
void dshot_write(const float motor[DSHOT_MOTOR_COUNT]);
/** How many motor channels have a TIM handle (0 on dummy IR). */
unsigned dshot_bound_count(void);
bool dshot_is_healthy(void);

/** 11-bit throttle → 16-bit DShot packet (telem bit 0 + nibble XOR CRC). */
uint16_t dshot_encode_packet(uint16_t throttle11);
/** Same as encode_packet but sets the telemetry-request bit when request_telem. */
uint16_t dshot_encode_packet_ex(uint16_t throttle11, bool request_telem);
/** Expand packet MSB-first into CCR high-time buffer; out_n >= DSHOT_BURST_LEN. */
void dshot_expand_frame(uint16_t packet, uint16_t *out, size_t out_n);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_DSHOT_H */
