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
} blackbox_metadata_t;
/* All-I, self-contained binary records. 0 means invalid input or insufficient
 * capacity. On failure destination is unchanged. No heap/I/O. Header is emitted
 * outside the control loop. Revision must be a single printable ASCII line. */
size_t blackbox_header(char *dst, size_t cap, const blackbox_metadata_t *metadata);
size_t blackbox_frame(uint8_t *dst, size_t cap, const flight_log_sample_t *sample);
size_t blackbox_end(uint8_t *dst, size_t cap);
#endif
