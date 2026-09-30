/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_DSHOT_IC_TAIL_H
#define BOBFLIGHT_DSHOT_IC_TAIL_H
/* Quiet time after the last captured edge ("tail"), in timer ticks, for the
 * bidir DShot capture window. Pure function shared by the F7 HAL and the host
 * timeline simulation.
 *
 * The capture timer free-runs with ARR = 0xFFFF from the moment the window
 * opens (cnt_open). At 216 MHz (TIM1) one 16-bit wrap is ~302 us, shorter
 * than a 1 kHz loop period, so a plain 16-bit difference cnt_now - last_ts
 * can alias and make a complete reply look truncated. The HAL therefore also
 * reports whether the timer overflowed (UIF, cleared at window open).
 *
 * The result is always a LOWER bound of the true quiet time (fail-safe: an
 * underestimate can only turn a good reply into "truncated" -> timeout,
 * never make a truncated reply look complete):
 *  - edge_pending (CCxIF set, not taken by DMA): 0;
 *  - no wrap: exact 16-bit difference;
 *  - wrapped and the last edge came before the first wrap
 *    (last_ts >= cnt_open): (0x10000 - last_ts) + cnt_now, saturated;
 *  - wrapped and the last edge came after it: 16-bit difference (exact for
 *    one wrap, an underestimate for more).
 * Saturates at 0xFFFF (= HAL_DSHOT_IC_TAIL_QUIET). */
#include <stdbool.h>
#include <stdint.h>

static inline uint16_t dshot_ic_tail_ticks(uint16_t cnt_open, uint16_t last_ts, uint16_t cnt_now,
                                           bool wrapped, bool edge_pending)
{
    uint32_t tail;
    if (edge_pending) {
        return 0u;
    }
    if (wrapped && last_ts >= cnt_open) {
        tail = (0x10000u - (uint32_t)last_ts) + (uint32_t)cnt_now;
    } else {
        tail = (uint16_t)(cnt_now - last_ts);
    }
    return tail > 0xFFFFu ? (uint16_t)0xFFFFu : (uint16_t)tail;
}
#endif
