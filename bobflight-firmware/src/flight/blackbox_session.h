/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_BLACKBOX_SESSION_H
#define BOBFLIGHT_BLACKBOX_SESSION_H
#include "drivers/fat32_log.h"
#include "flight/blackbox_encode.h"
/* Encoded-byte RAM ring between the encoder and 512-byte sector writes. It
 * rides out card write-latency stalls (64 KiB is ~2 s at 500 Hz x ~62 B).
 * On STM32F7 it lives in SRAM1 (.dma window), not in the 64 KiB DTCM. */
#define BB_SESSION_RING_BYTES 65536u
/* Samples encoded per poll call (bounded work; ring space is checked first). */
#define BB_SESSION_FRAMES_PER_POLL 16u
/* One encoded frame or the end marker; sized to the encoder's proven
 * worst-case frame (blackbox_encode.h), checked by static asserts. */
#define BB_SESSION_PACKET_BYTES BLACKBOX_FRAME_MAX_BYTES
_Static_assert(BB_SESSION_PACKET_BYTES >= BLACKBOX_FRAME_MAX_BYTES, "session packet must hold a worst-case frame");
_Static_assert(BB_SESSION_PACKET_BYTES >= 13u, "session packet must hold the end marker");
_Static_assert(BB_SESSION_PACKET_BYTES < 65536u / 4u, "ring must hold several worst-case frames");
/* Deterministic auto-rate policy: evaluated once per window of session time.
 * If queue-full drops in the window exceed BB_RATE_DROP_PERMILLE of the
 * window's due logging slots (capture attempts minus deliberate decimation,
 * so the threshold means the same at 1, 4 and 8 kHz loops), halve the rate
 * (500 -> 250 -> 125). Never raised in a session and never below
 * BB_RATE_FLOOR_HZ. Only queue-full losses count. */
#define BB_RATE_WINDOW_US 1000000u
#define BB_RATE_DROP_PERMILLE 10u
#define BB_RATE_FLOOR_HZ 125u
/* Windows ignored right after a halving while the old-rate backlog drains. */
#define BB_RATE_SETTLE_WINDOWS 1u
#define BB_RATE_REASON_DEFAULT "default"
#define BB_RATE_REASON_CARD_SLOW "auto-lowered-card-slow"
typedef enum {BBS_IDLE,BBS_PREPARING,BBS_HEADER,BBS_RECORDING,BBS_DRAINING,BBS_CLOSING,BBS_DONE,BBS_ERROR} bb_session_phase_t;
typedef struct {
 bb_session_phase_t phase;fatlog_t file;const char *reason;
 uint64_t started_us;uint32_t sample_hz,frames;
 uint32_t requested_hz,header_hz,rate_lowerings;const char *rate_reason;
 bool stop_requested,end_created,seen_armed,patch_done;
 blackbox_encoder_state_t encoder;
 blackbox_metadata_t meta;uint32_t header_tail_hash;
 char header[BLACKBOX_HEADER_MAX_BYTES];size_t header_len;
 uint8_t sector[512],packet[BB_SESSION_PACKET_BYTES];
 size_t ring_head,ring_tail,ring_count,ring_peak;
 uint64_t window_start_us;uint32_t window_lost0,window_attempted0,settle_windows;
 uint64_t recording_started_us; /* capture start (BBS_RECORDING), for blackbox_logged_hz */
} bb_session_t;
bool bb_session_start(bb_session_t *s,const fatlog_io_t *io,const blackbox_metadata_t *metadata,uint64_t now);
void bb_session_poll(bb_session_t *s,uint64_t now);
void bb_session_stop(bb_session_t *s);
bool bb_session_busy(const bb_session_t *s);
const char *bb_session_name(const bb_session_t *s);
/* Samples lost because the recorder FIFO was full (not invalid/regressed input). */
uint32_t bb_session_queue_full_drops(void);
#endif
