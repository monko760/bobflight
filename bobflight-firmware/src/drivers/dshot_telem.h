/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bidirectional DShot M1 telemetry snapshot (R0b). RAM flag default off.
 * Lead CLI maps get erpm_m1 / dshot_telem_m1 / set dshot_bidir here.
 *
 * Driver/HAL feed APIs (ingest / arm_listen / poll) are for the TX→IC path
 * and host tests — not CLI surface.
 */
#ifndef BOBFLIGHT_DSHOT_TELEM_H
#define BOBFLIGHT_DSHOT_TELEM_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

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

/** Age after last OK decode before status reports STALE (ms). */
#define DSHOT_TELEM_STALE_MS 100u

void dshot_bidir_set_enabled(bool on); /* default off */
bool dshot_bidir_enabled(void);

/* Latest M1 only (R0b). Safe from CLI / bg; no heap. */
uint32_t dshot_m1_erpm(void);                 /* 0 if not OK */
dshot_telem_status_t dshot_m1_telem_status(void);
uint32_t dshot_m1_telem_age_ms(void);         /* since last OK decode */
uint32_t dshot_m1_telem_period_us(void);      /* 0 if not OK */

/**
 * Feed a completed 21-bit GCR wire word (low 21 bits) into the M1 snapshot.
 * Host tests and HAL completion paths use this; maps dshot_gcr_status → telem.
 */
void dshot_telem_m1_ingest_gcr21(uint32_t bits21);

/**
 * Assemble a 21-bit wire word from inter-edge timer deltas, then ingest.
 * bit_period_ticks is the expected telem bit period in the same units as
 * deltas (public: telem rate = 5/4 outbound DShot bitrate → period = 4/5).
 * Returns false if fewer than 21 bits could be assembled (notes TIMEOUT).
 */
bool dshot_telem_m1_ingest_edge_deltas(const uint16_t *deltas, size_t n,
                                       uint16_t bit_period_ticks);

/** Record a listen-window miss (no edges). */
void dshot_telem_m1_note_timeout(void);

/**
 * After M1 DShot TX is queued/fired: arm TIM3_CH3 IC listen (same pin).
 * No-op when bidir is off. TX TIM3_UP DMA path is unchanged.
 */
void dshot_telem_m1_arm_listen(void);

/**
 * Poll IC completion → edge assemble → GCR → snapshot.
 * Safe to call from a background/CLI context; no-op if not armed.
 */
void dshot_telem_m1_poll(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_DSHOT_TELEM_H */
