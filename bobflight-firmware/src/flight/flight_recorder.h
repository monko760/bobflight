/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Core flight recorder FIFO and session decimation.
 */
#ifndef BOBFLIGHT_FLIGHT_RECORDER_H
#define BOBFLIGHT_FLIGHT_RECORDER_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define FLIGHT_RECORDER_QUEUE_CAPACITY 64

typedef struct {
    uint32_t iteration;
    uint32_t time_us;       /* Session-relative timestamp */
    uint32_t dt_us;
    float gyro_raw[3];
    float gyro[3];
    float setpoint[3];
    float p[3];
    float i[3];
    float d[3];
    float pid_output[3];
    float motor[4];         /* [0.0, 1.0] normalized command */
    float rc[4];            /* R/P/Y [-1.0, 1.0], Throttle [0.0, 1.0] */
    uint8_t armed;
    uint8_t mode;
    uint8_t failsafe;
    uint8_t pid_valid, gyro_valid, rx_fresh, output_healthy;
    uint32_t dropped;       /* Cumulative drops prior to this record */
    /* Log schema 3 (docs/BLACKBOX-FIELDS.md). Raw values; the encoder scales. */
    uint32_t erpm[4];       /* Bidir DShot eRPM per motor, 0 if no valid telemetry */
    uint8_t telem_ok;       /* bit m = motor m+1 telemetry OK (0..15) */
    uint8_t filter_flags;   /* BB_FILTER_* bits (0..127) */
    uint8_t events;         /* BB_EVENT_* bits latched since the previous logged frame (0..127) */
    uint8_t loop_code;      /* target loop Hz / 250 (0 = unknown, 1..32) */
    uint32_t overruns;      /* scheduler overruns since the session started */
} flight_log_sample_t;

/* bobflightTelemOk: bit 0 = M1 .. bit 3 = M4 (DShot telemetry status OK). */
#define BB_TELEM_OK_MAX 15u
/* bobflightFilterFlags (bit 0 = LSB). */
#define BB_FILTER_NOTCH1_ACTIVE   (1u << 0)
#define BB_FILTER_NOTCH2_ACTIVE   (1u << 1)
#define BB_FILTER_RPM_ACTIVE      (1u << 2)
#define BB_FILTER_RPM_REASON_SHIFT 3u  /* 2 bits: 0 off, 1 bidir-off, 2 erpm-unavailable, 3 ok */
#define BB_FILTER_RPM_HARM_SHIFT   5u  /* 2 bits: rpm harmonics_active 0..3 */
#define BB_FILTER_FLAGS_MAX 127u
/* bobflightEvents (bit 0 = LSB): set when the transition happened at any PID
 * loop since the previous LOGGED frame; cleared once a frame carrying them is
 * accepted into the log queue. A frame that is dropped keeps them latched. */
#define BB_EVENT_ARM              (1u << 0) /* disarmed -> armed */
#define BB_EVENT_DISARM           (1u << 1) /* armed -> disarmed */
#define BB_EVENT_FAILSAFE_STAGE   (1u << 2) /* failsafe stage changed (either direction) */
#define BB_EVENT_RX_LOST          (1u << 3) /* receiver frame fresh -> not fresh */
#define BB_EVENT_MODE             (1u << 4) /* effective control mode changed */
#define BB_EVENT_LOOP_RATE        (1u << 5) /* target loop rate (bobflightLoopCode) changed */
#define BB_EVENT_TELEM_CAPTURE_FAIL (1u << 6) /* bidir DShot capture failure latched */
#define BB_EVENTS_MAX 127u
/* bobflightLoopCode = target loop Hz / 250: 4 = 1 kHz, 8 = 2 kHz, 16 = 4 kHz, 32 = 8 kHz. */
#define BB_LOOP_CODE_MAX 32u

/* Shared by the recorder and the encoder so an accepted sample always encodes. */
static inline bool flight_log_sample_flags_valid(const flight_log_sample_t *s)
{
    return s && s->armed <= 1u && s->mode <= 2u && s->failsafe <= 2u && s->pid_valid <= 1u &&
           s->gyro_valid <= 1u && s->rx_fresh <= 1u && s->output_healthy <= 1u &&
           s->telem_ok <= BB_TELEM_OK_MAX && s->filter_flags <= BB_FILTER_FLAGS_MAX &&
           s->events <= BB_EVENTS_MAX && s->loop_code <= BB_LOOP_CODE_MAX;
}

typedef struct {
    uint32_t rate_hz;
    uint32_t total_attempted;
    uint32_t total_accepted;
    uint32_t total_dropped;
    uint32_t total_skipped; /* Deliberately decimated calls */
    uint32_t total_missed; /* Elapsed logging slots not fabricated */
    uint32_t total_invalid;
    uint32_t total_regressed;
    uint32_t queue_depth;
    uint32_t queue_capacity;
} flight_recorder_stats_t;

void recorder_reset(void);
bool recorder_start(uint32_t rate_hz);
void recorder_stop(void);
/* Lower the active decimation rate (125/250/500/1000 Hz only, strictly lower). */
bool recorder_lower_rate(uint32_t rate_hz);
bool recorder_capture(const flight_log_sample_t *sample);
/* Decimation fast path, called BEFORE a sample is built: if a capture at
 * (time_us, iteration) would only be decimated, count it exactly as
 * recorder_capture() counts a decimated valid sample (attempted + skipped) and
 * return true; the caller must then not build or submit a sample. Returns false
 * when the slot is due, the recorder is idle/first, or the input regressed
 * (recorder_capture() then validates and counts it as before). */
bool recorder_skip_if_not_due(uint32_t time_us, uint32_t iteration);
bool recorder_pop(flight_log_sample_t *out_sample);
bool recorder_active(void);
const flight_recorder_stats_t *recorder_stats(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_FLIGHT_RECORDER_H */
