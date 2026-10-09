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

typedef struct {
    int16_t rssi1_dbm;      /** Uplink RSSI 1 (dBm, e.g. -60) */
    int16_t rssi2_dbm;      /** Uplink RSSI 2 (dBm, e.g. -62) */
    uint8_t uplink_lq;      /** Uplink Link Quality (0..100 %) */
    int8_t  uplink_snr;     /** Uplink SNR (dB) */
    uint8_t active_antenna; /** Active/selected antenna index (0 or 1) */
    uint8_t rf_mode;        /** RF mode / profile */
} crsf_link_stats_t;

/** CRC8, poly 0xD5, over type+payload (public CRSF). */
uint8_t crsf_crc8(const uint8_t *data, size_t len);

/**
 * Parse one CRSF RC channels frame (addr+len+type+22 payload+crc).
 * On success writes 16 normalized channels roughly [-1,1] (mid 992 → 0).
 * Rejects wrong sync, length, type, or CRC.
 */
bool crsf_parse_rc_frame(const uint8_t *frame, size_t n, float out[16]);

/**
 * Parse one CRSF LINK_STATISTICS frame (type 0x14, 10-byte payload).
 * Writes the uplink link quality (%, payload byte 2) and, when rf_profile is
 * not NULL, the RF profile (payload byte 5; CRSF spec enum 4fps=0, 50fps=1,
 * 150fps=2; other values are passed through unchanged). Rejects wrong sync,
 * length, type, CRC, uplink LQ above 100, or active antenna index > 1.
 */
#define CRSF_RF_PROFILE_4FPS 0u
bool crsf_parse_link_stats(const uint8_t *frame, size_t n, uint8_t *uplink_lq, uint8_t *rf_profile);

/**
 * Parse one CRSF LINK_STATISTICS frame into a full crsf_link_stats_t structure.
 * Rejects wrong sync, length, type, CRC, uplink LQ above 100, or active antenna index > 1.
 */
bool crsf_parse_link_stats_full(const uint8_t *frame, size_t n, crsf_link_stats_t *stats);

#ifdef __cplusplus
}
#endif

void crsf_to_controls(const float raw[16],float controls[16]);
bool crsf_set_map(const char *map);
const char *crsf_map(void);
uint32_t crsf_crc_errors(void);
uint32_t crsf_stream_resets(void);
#endif /* BOBFLIGHT_CRSF_H */
