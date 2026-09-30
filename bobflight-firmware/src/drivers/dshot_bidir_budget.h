/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bidirectional DShot reply-window budget (B2). Header-only integer math so
 * the loop-rate policy, the host tests and docs/DSHOT-BIDIR-4K.md use the
 * same numbers. Public protocol facts (BDShot): the ESC answers every
 * inverted frame ~30 us after the frame ends with 21 GCR bits at 5/4 the
 * outbound bit rate.
 *
 * TX timeline of one burst (hal_tim_dma.c): 1 leading idle bit period, 16
 * data bits, 4 idle slots. The TX DMA transfer-complete (TC) fires at the
 * update that latches slot 18, i.e. 19 bit periods after the start; the TC
 * IRQ then switches the channels to input capture. The reply must be fully
 * captured before the next cycle's harvest (one loop period after TX, minus
 * cascade-to-cascade jitter).
 *
 * A loop rate is "proven" for bidir only when, with the WORST-case budget
 * below, the window closes before the next harvest AND capture is live
 * before the earliest possible reply.
 */
#ifndef BOBFLIGHT_DSHOT_BIDIR_BUDGET_H
#define BOBFLIGHT_DSHOT_BIDIR_BUDGET_H

#include <stdbool.h>
#include <stdint.h>

#define DSHOT_BIDIR_TX_LEAD_BITS      1u  /* leading all-idle bit (hal_tim_dma.c) */
#define DSHOT_BIDIR_TX_DATA_BITS      16u
#define DSHOT_BIDIR_TX_TC_BITS        19u /* TC after the 19th DMA transfer */
#define DSHOT_BIDIR_REPLY_BITS        21u
#define DSHOT_BIDIR_ISR_NS            2000u  /* TC IRQ entry + reprogram (budget) */
#define DSHOT_BIDIR_TURNAROUND_MIN_NS 25000u /* earliest ESC reply after frame end */
#define DSHOT_BIDIR_TURNAROUND_NOM_NS 30000u /* public nominal */
#define DSHOT_BIDIR_TURNAROUND_MAX_NS 40000u /* worst case budgeted */
#define DSHOT_BIDIR_JITTER_NS         30000u /* cascade-to-cascade TX start jitter allowance */

/* One outbound bit period in ns (300 -> 3333, 600 -> 1666). 0 if kbps == 0. */
static inline uint32_t dshot_bidir_bit_ns(unsigned kbps)
{
    return kbps ? 1000000u / kbps : 0u;
}
/* Telemetry bit period: 4/5 of the outbound bit. */
static inline uint32_t dshot_bidir_reply_bit_ns(unsigned kbps)
{
    return dshot_bidir_bit_ns(kbps) * 4u / 5u;
}
/* End of the last data bit, from TX start. */
static inline uint32_t dshot_bidir_frame_end_ns(unsigned kbps)
{
    return (DSHOT_BIDIR_TX_LEAD_BITS + DSHOT_BIDIR_TX_DATA_BITS) * dshot_bidir_bit_ns(kbps);
}
/* Input capture live (TC + IRQ), from TX start. */
static inline uint32_t dshot_bidir_capture_live_ns(unsigned kbps)
{
    return DSHOT_BIDIR_TX_TC_BITS * dshot_bidir_bit_ns(kbps) + DSHOT_BIDIR_ISR_NS;
}
static inline uint32_t dshot_bidir_reply_ns(unsigned kbps)
{
    return DSHOT_BIDIR_REPLY_BITS * dshot_bidir_reply_bit_ns(kbps);
}
/* Last reply edge from TX start with the given turnaround. */
static inline uint32_t dshot_bidir_reply_end_ns(unsigned kbps, uint32_t turnaround_ns)
{
    return dshot_bidir_frame_end_ns(kbps) + turnaround_ns + dshot_bidir_reply_ns(kbps);
}
/* Worst-case window that must fit in one loop period (reply end + jitter). */
static inline uint32_t dshot_bidir_need_ns(unsigned kbps)
{
    return dshot_bidir_reply_end_ns(kbps, DSHOT_BIDIR_TURNAROUND_MAX_NS) + DSHOT_BIDIR_JITTER_NS;
}
/* True when bidir receive is proven to fit a loop of loop_hz at kbps. */
static inline bool dshot_bidir_window_fits(uint32_t loop_hz, unsigned kbps)
{
    uint32_t period_ns;
    if (loop_hz == 0u || (kbps != 300u && kbps != 600u)) {
        return false;
    }
    period_ns = 1000000000u / loop_hz;
    if (dshot_bidir_capture_live_ns(kbps) >
        dshot_bidir_frame_end_ns(kbps) + DSHOT_BIDIR_TURNAROUND_MIN_NS) {
        return false; /* capture would open after the earliest reply edge */
    }
    return dshot_bidir_need_ns(kbps) <= period_ns;
}

#endif /* BOBFLIGHT_DSHOT_BIDIR_BUDGET_H */
