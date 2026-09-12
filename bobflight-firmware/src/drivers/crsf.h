/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * CRSF pure helpers for host unit tests and the UART RX path.
 * Clean-room from public CRSF/ELRS docs (CRC8 poly 0xD5, 11-bit packed RC).
 */
#ifndef BOBFLIGHT_CRSF_H
#define BOBFLIGHT_CRSF_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/** CRC8, poly 0xD5, over type+payload (public CRSF). */
uint8_t crsf_crc8(const uint8_t *data, size_t len);

/**
 * Parse one CRSF RC channels frame (addr+len+type+22 payload+crc).
 * On success writes 16 normalized channels roughly [-1,1] (mid 992 → 0).
 * Rejects wrong sync, length, type, or CRC.
 */
bool crsf_parse_rc_frame(const uint8_t *frame, size_t n, float out[16]);

#ifdef __cplusplus
}
#endif

void crsf_to_controls(const float raw[16],float controls[16]);
#endif /* BOBFLIGHT_CRSF_H */
