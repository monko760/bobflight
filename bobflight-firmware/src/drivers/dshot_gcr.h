/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host-testable clean-room bidirectional DShot GCR ↔ eRPM decode.
 *
 * Public protocol (Joe Lucid BDShot / BLHeli notes / Betaflight DSHOT wiki
 * protocol description — not derived from GPL firmware source):
 *
 *   ESC → FC telemetry is a 21-bit differential GCR bitstream at 5/4 the
 *   outbound DShot bitrate. Decode:
 *     1) gcr20 = (bits21 ^ (bits21 >> 1)) & 0xFFFFF
 *     2) Split into four 5-bit symbols → 4-bit nibbles via the public map
 *     3) 16-bit payload = 12-bit period | 4-bit CRC
 *   CRC: XOR of the four nibbles must equal 0xF (complemented nibble-XOR).
 *   Period layout: eee_mmmmmmmmm → period_us = M << E
 *   eRPM = 60_000_000 / period_us  (electrical RPM; poles applied by caller)
 *
 * STALE: zero period_us after a CRC-valid payload, or age past a caller
 * threshold via dshot_gcr_age_is_stale().
 *
 * No HAL / TIM / DMA / pin AF — pure integer helpers for R0a.
 */
#ifndef BOBFLIGHT_DSHOT_GCR_H
#define BOBFLIGHT_DSHOT_GCR_H

#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Decode / validate status for a GCR telemetry frame. */
typedef enum {
    DSHOT_GCR_OK = 0,
    DSHOT_GCR_CRC_FAIL,
    DSHOT_GCR_INVALID_GCR,
    DSHOT_GCR_STALE
} dshot_gcr_status_t;

/** Result of decoding a 21-bit GCR bitstream into eRPM. */
typedef struct {
    dshot_gcr_status_t status;
    uint16_t payload16;   /**< 12-bit period + 4-bit CRC when GCR valid */
    uint16_t period12;    /**< eee_mmmmmmmmm field (valid on OK / STALE) */
    uint32_t period_us;   /**< M << E microseconds (0 if stale/invalid) */
    uint32_t erpm;        /**< 60e6 / period_us (0 if stale/invalid) */
} dshot_gcr_result_t;

/**
 * Map a 4-bit nibble to the public 5-bit BDShot GCR code.
 * nibble is masked to 0..15.
 */
uint8_t dshot_gcr_encode_nibble(uint8_t nibble);

/**
 * Map a 5-bit GCR symbol to a 4-bit nibble.
 * Returns false if the 5-bit code is not in the public map (INVALID_GCR).
 */
bool dshot_gcr_decode_nibble(uint8_t gcr5, uint8_t *out_nibble);

/**
 * Encode a 16-bit telemetry payload (period12<<4 | crc4) into a 21-bit
 * differential GCR word (MSB of the 21 is the leading 0 start bit).
 * Encode helper for host tests / TX simulation only.
 */
uint32_t dshot_gcr_encode_21(uint16_t payload16);

/**
 * Build the 16-bit BDShot telemetry payload for a 12-bit period field:
 * crc4 = ~(p ^ p>>4 ^ p>>8) & 0xF; return (p << 4) | crc4.
 */
uint16_t dshot_gcr_pack_payload(uint16_t period12);

/**
 * Pack period_us into the public eee_mmmmmmmmm 12-bit field (lossy for
 * values that need more than 9 mantissa bits). Used by tests.
 */
uint16_t dshot_gcr_pack_period12(uint32_t period_us);

/**
 * Decode a 21-bit GCR bitstream (bits in the low 21 of bits21) into
 * period / eRPM. status is OK, CRC_FAIL, INVALID_GCR, or STALE (zero period).
 */
dshot_gcr_result_t dshot_gcr_decode_21(uint32_t bits21);

/**
 * Convert a validated 12-bit period field to microseconds (M << E).
 */
uint32_t dshot_gcr_period12_to_us(uint16_t period12);

/**
 * Convert period_us to electrical RPM: floor(60_000_000 / period_us).
 * Returns 0 if period_us == 0.
 */
uint32_t dshot_gcr_period_us_to_erpm(uint32_t period_us);

/**
 * Caller-supplied freshness helper: true when age_us > threshold_us.
 * threshold_us == 0 means "never stale by age".
 */
bool dshot_gcr_age_is_stale(uint32_t age_us, uint32_t threshold_us);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_DSHOT_GCR_H */
