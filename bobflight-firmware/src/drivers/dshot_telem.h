/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Bidirectional DShot telemetry snapshot (R0c: M1–M4). RAM flag default off.
 * Lead CLI maps get erpm_m1..m4 / dshot_telem_m1..m4 / set dshot_bidir here.
 *
 * Primary API is motor-indexed (0..3, M1=0). dshot_m1_* are thin wrappers.
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

/** Motors with bidir IC on Kakute R0c (M1–M4). */
#define DSHOT_TELEM_MOTOR_COUNT 4u

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
/** Capture buffer per motor (raw timer timestamps). */
#define DSHOT_TELEM_EDGE_CAP 64u
/** Longest same-level run in a valid 21-bit BDShot reply (GCR: <= 2 zeros). */
#define DSHOT_TELEM_MAX_RUN_BITS 3u
/**
 * Consecutive cycles with a capture failure (window never opened, DMA
 * error, or reply cut off by the harvest) before dshot_telem_capture_failed()
 * latches. 32 cycles = 8 ms at 4 kHz, 32 ms at 1 kHz. A silent ESC never
 * counts (TIMEOUT only).
 */
#define DSHOT_TELEM_CAPTURE_FAIL_LIMIT 32u

void dshot_bidir_set_enabled(bool on); /* default off */
bool dshot_bidir_enabled(void);

/* ---- Primary indexed API (motor 0..3, M1=0) ---- */
uint32_t dshot_erpm(unsigned motor);                 /* 0 if not OK */
dshot_telem_status_t dshot_telem_status(unsigned motor);
uint32_t dshot_telem_age_ms(unsigned motor);         /* since last OK decode */
uint32_t dshot_telem_period_us(unsigned motor);      /* 0 if not OK */

/* M1 wrappers → motor 0 (Lead CLI / R0b compat). */
static inline uint32_t dshot_m1_erpm(void)
{
    return dshot_erpm(0u);
}
static inline dshot_telem_status_t dshot_m1_telem_status(void)
{
    return dshot_telem_status(0u);
}
static inline uint32_t dshot_m1_telem_age_ms(void)
{
    return dshot_telem_age_ms(0u);
}
static inline uint32_t dshot_m1_telem_period_us(void)
{
    return dshot_telem_period_us(0u);
}

/**
 * Feed a completed 21-bit GCR wire word (low 21 bits) into motor snapshot.
 * Host tests and HAL completion paths use this; maps dshot_gcr_status → telem.
 */
void dshot_telem_ingest_gcr21(unsigned motor, uint32_t bits21);

/**
 * Assemble a 21-bit wire word from inter-edge timer deltas, then ingest.
 * bit_period_ticks is the expected telem bit period in the same units as
 * deltas (public: telem rate = 5/4 outbound DShot bitrate → period = 4/5).
 * Returns false if fewer than 21 bits could be assembled (notes TIMEOUT).
 */
bool dshot_telem_ingest_edge_deltas(unsigned motor, const uint16_t *deltas,
                                    size_t n, uint16_t bit_period_ticks);

/**
 * Decode one capture window: n raw 16-bit timer timestamps (edge times),
 * bit_period_ticks = telem bit in timer ticks, tail_ticks = ticks from the
 * last edge to the harvest (HAL_DSHOT_IC_TAIL_QUIET if the line was quiet).
 * Returns true when a full 21-bit frame was assembled and handed to GCR.
 */
bool dshot_telem_ingest_capture(unsigned motor, const uint16_t *ts, size_t n,
                                uint16_t bit_period_ticks, uint16_t tail_ticks);

/** Latched: DSHOT_TELEM_CAPTURE_FAIL_LIMIT failing cycles in a row (bidir on). */
bool dshot_telem_capture_failed(void);
/** Current consecutive capture-failure cycle count (0 when bidir off). */
uint32_t dshot_telem_capture_fail_streak(void);
/** Harvest cycles since bidir was enabled (diagnostic / tests). */
uint32_t dshot_telem_cycles(void);

/** Record a listen-window miss (no edges) for one motor. */
void dshot_telem_note_timeout(unsigned motor);

/**
 * BEFORE this cycle's DShot TX: register the capture buffer (non-blocking).
 * The TX DMA TC IRQ switches TIMx_CHy to input capture after the frame.
 * No-op when bidir is off or motor out of range.
 */
void dshot_telem_arm_listen(unsigned motor);

/** Arm listen on motors 0..DSHOT_TELEM_MOTOR_COUNT-1. */
void dshot_telem_arm_listen_all(void);

/**
 * Harvest (non-blocking) → edge assemble → GCR → snapshot for one motor.
 * No-op if not armed. Never waits for edges.
 */
void dshot_telem_poll(unsigned motor);

/** Harvest + decode the previous frame's replies; updates the failure latch. */
void dshot_telem_poll_all(void);

/* Thin M1 ingest/arm/poll wrappers → motor 0 (host / R0b call sites). */
static inline void dshot_telem_m1_ingest_gcr21(uint32_t bits21)
{
    dshot_telem_ingest_gcr21(0u, bits21);
}
static inline bool dshot_telem_m1_ingest_edge_deltas(const uint16_t *deltas,
                                                    size_t n,
                                                    uint16_t bit_period_ticks)
{
    return dshot_telem_ingest_edge_deltas(0u, deltas, n, bit_period_ticks);
}
static inline void dshot_telem_m1_note_timeout(void)
{
    dshot_telem_note_timeout(0u);
}
static inline void dshot_telem_m1_arm_listen(void)
{
    dshot_telem_arm_listen(0u);
}
static inline void dshot_telem_m1_poll(void)
{
    dshot_telem_poll(0u);
}

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_DSHOT_TELEM_H */
