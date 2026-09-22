/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bidirectional DShot M1 telemetry snapshot (R0b). RAM flag default off.
 * Lead CLI maps get erpm_m1 / dshot_telem_m1 / set dshot_bidir here.
 */
#ifndef BOBFLIGHT_DSHOT_TELEM_H
#define BOBFLIGHT_DSHOT_TELEM_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    DSHOT_TELEM_NONE = 0, /* bidir off or never sampled */
    DSHOT_TELEM_OK,
    DSHOT_TELEM_CRC_FAIL,
    DSHOT_TELEM_INVALID,  /* GCR/nibble fail */
    DSHOT_TELEM_TIMEOUT,  /* no edge train */
    DSHOT_TELEM_STALE     /* age > threshold */
} dshot_telem_status_t;

void dshot_bidir_set_enabled(bool on); /* default off */
bool dshot_bidir_enabled(void);

/* Latest M1 only (R0b). Safe from CLI / bg; no heap. */
uint32_t dshot_m1_erpm(void);                 /* 0 if not OK */
dshot_telem_status_t dshot_m1_telem_status(void);
uint32_t dshot_m1_telem_age_ms(void);         /* since last OK decode */
uint32_t dshot_m1_telem_period_us(void);      /* 0 if not OK */

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_DSHOT_TELEM_H */
