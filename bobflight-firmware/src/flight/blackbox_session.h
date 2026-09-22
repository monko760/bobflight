/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_BLACKBOX_SESSION_H
#define BOBFLIGHT_BLACKBOX_SESSION_H
#include "drivers/fat32_log.h"
#include "flight/blackbox_encode.h"
typedef enum {BBS_IDLE,BBS_PREPARING,BBS_HEADER,BBS_RECORDING,BBS_DRAINING,BBS_CLOSING,BBS_DONE,BBS_ERROR} bb_session_phase_t;
typedef struct {
 bb_session_phase_t phase;fatlog_t file;const char *reason;
 uint64_t started_us;uint32_t sample_hz,frames;
 bool stop_requested,end_created,seen_armed;
 char header[4096];size_t header_len,header_pos;
 uint8_t sector[512],packet[256];size_t used,packet_len,packet_pos;
} bb_session_t;
bool bb_session_start(bb_session_t *s,const fatlog_io_t *io,const blackbox_metadata_t *metadata,uint64_t now);
void bb_session_poll(bb_session_t *s,uint64_t now);
void bb_session_stop(bb_session_t *s);
bool bb_session_busy(const bb_session_t *s);
const char *bb_session_name(const bb_session_t *s);
#endif
