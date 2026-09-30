/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_BLACKBOX_ENCODE_H
#define BOBFLIGHT_BLACKBOX_ENCODE_H
#include <stddef.h>
#include <stdint.h>
#include "flight/flight_recorder.h"
#include "flight/config.h"
typedef struct {
 uint32_t sample_hz, loop_hz, dshot_kbps;
 const char *revision;
 const bf_config_t *config; /* Actual saved/runtime rates and gains */
 uint32_t requested_hz;   /* Configured/default rate; 0 means sample_hz */
 const char *rate_reason; /* "default" or "auto-lowered-card-slow"; NULL means default */
} blackbox_metadata_t;
/* The rate-dependent header block (I/P interval + BobFlight log rate line) has
 * a fixed byte length for every supported rate/reason, and sits in the first
 * 512-byte sector, so a closing writer can patch the effective rate in place. */
#define BLACKBOX_RATE_BLOCK_BYTES 128u
/* All-I, self-contained binary records. 0 means invalid input or insufficient
 * capacity. On failure destination is unchanged. No heap/I/O. Header is emitted
 * outside the control loop. Revision must be a single printable ASCII line. */
size_t blackbox_header(char *dst, size_t cap, const blackbox_metadata_t *metadata);
size_t blackbox_frame(uint8_t *dst, size_t cap, const flight_log_sample_t *sample);
size_t blackbox_end(uint8_t *dst, size_t cap);
#endif
