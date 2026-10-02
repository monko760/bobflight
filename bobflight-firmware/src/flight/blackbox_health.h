/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Blackbox session health readouts (frozen by the Config Lead, BB1 QA F2):
 * blackbox_missed_pct, blackbox_logged_hz and blackbox_missed_state. Pure
 * integer math so the host tests pin exactly what `blackbox status` prints.
 * Missed slots are reported here only; they never feed the auto-rate policy. */
#ifndef BOBFLIGHT_BLACKBOX_HEALTH_H
#define BOBFLIGHT_BLACKBOX_HEALTH_H
#include <stdbool.h>
#include <stdint.h>
/* Percent in tenths, rounded half up, exactly as blackbox_drop_pct prints it
 * (tenths = (part*1000 + total/2) / total; 0 -> "0.0" when total is 0).
 * blackbox_missed_pct = bb_pct_tenths(missed, frames + dropped + missed). */
static inline uint32_t bb_pct_tenths(uint64_t part,uint64_t total){
 return total?(uint32_t)((part*1000u+total/2u)/total):0u;
}
/* blackbox_missed_state is "high" when the PRINTED missed_pct is above 1.0,
 * i.e. compared on the same rounded tenths: 1.0 (exact 1.00..1.04 %) is ok,
 * 1.1 (exact >= 1.05 %) is high. The state never contradicts the printed pct. */
#define BB_MISSED_HIGH_ABOVE_TENTHS 10u
static inline bool bb_missed_high(uint32_t missed_pct_tenths){return missed_pct_tenths>BB_MISSED_HIGH_ABOVE_TENTHS;}
/* blackbox_logged_hz: session average = frames / elapsed recording time, in
 * tenths of Hz rounded half up. Unavailable (false) when not recording or
 * before BB_LOGGED_HZ_MIN_US of recording. A session average reacts slowly:
 * a late stall shows in missed_pct / missed_state first. */
#define BB_LOGGED_HZ_MIN_US 1000000u
static inline bool bb_logged_hz_tenths(bool recording,uint32_t frames,uint64_t elapsed_us,uint32_t *tenths_hz){
 if(!recording||elapsed_us<BB_LOGGED_HZ_MIN_US||!tenths_hz)return false;
 const uint64_t t=((uint64_t)frames*10000000u+elapsed_us/2u)/elapsed_us;
 *tenths_hz=t>UINT32_MAX?UINT32_MAX:(uint32_t)t;
 return true;
}
#endif
