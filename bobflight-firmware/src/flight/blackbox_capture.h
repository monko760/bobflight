/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_BLACKBOX_CAPTURE_H
#define BOBFLIGHT_BLACKBOX_CAPTURE_H
#include <stdbool.h>
#include <stdint.h>
#include "flight/pid.h"
#include "flight/flight_recorder.h"
/* Observer only: no I/O, arm/disarm, PID reset, or motor writes. */
bool bb_capture_begin(uint32_t hz,uint64_t epoch_us);
void bb_capture_end(void);
/* Slow per-frame inputs, read only for a sample that will actually be logged. */
typedef struct {
 uint32_t erpm[4];      /* raw eRPM, 0 if that motor has no valid telemetry */
 uint8_t telem_ok;      /* bit m = motor m+1 telemetry OK */
 uint8_t filter_flags;  /* BB_FILTER_* (flight/flight_recorder.h) */
} bb_capture_extra_t;
/* Cheap per-PID-loop context (events are detected on every call, logged or not). */
typedef struct {
 uint8_t loop_code;           /* target loop Hz / 250 */
 bool telem_capture_failed;   /* bidir DShot capture failure latched */
 uint32_t overruns_total;     /* scheduler overruns since boot */
 void (*fill)(bb_capture_extra_t *extra); /* NULL: extras stay zero */
} bb_capture_ctx_t;
/* Pure packers shared by the firmware gather code and the host tests. */
static inline uint8_t bb_loop_code(uint32_t loop_target_hz){
 const uint32_t c=loop_target_hz/250u;return (uint8_t)(c>BB_LOOP_CODE_MAX?BB_LOOP_CODE_MAX:c);
}
static inline uint8_t bb_filter_flags_pack(bool notch1,bool notch2,unsigned rpm_reason,unsigned harmonics_active){
 const bool rpm_active=rpm_reason==3u;
 return (uint8_t)((notch1?BB_FILTER_NOTCH1_ACTIVE:0u)|(notch2?BB_FILTER_NOTCH2_ACTIVE:0u)|
  (rpm_active?BB_FILTER_RPM_ACTIVE:0u)|((rpm_reason&3u)<<BB_FILTER_RPM_REASON_SHIFT)|
  ((rpm_active?(harmonics_active>3u?3u:harmonics_active):0u)<<BB_FILTER_RPM_HARM_SHIFT));
}
/* Every PID loop while recording. Decimation is decided before the sample is
 * built; ctx may be NULL (schema 3 extras, loop and telemetry events stay 0). */
void bb_capture_observe_ex(uint64_t pid_time_us,const float raw[3],const float filtered[3],
 const float setpoint[3],const pid_axis_out_t *output,const float motors[4],const float *rc,
 bool armed,uint8_t mode,uint8_t failsafe,bool gyro_valid,bool rx_fresh,bool output_healthy,
 const bb_capture_ctx_t *ctx);
void bb_capture_observe(uint64_t pid_time_us,const float raw[3],const float filtered[3],
 const float setpoint[3],const pid_axis_out_t *output,const float motors[4],const float *rc,
 bool armed,uint8_t mode,uint8_t failsafe,bool gyro_valid,bool rx_fresh,bool output_healthy);
/* Events latched and not yet carried by an accepted frame (tests/diagnostics). */
uint8_t bb_capture_pending_events(void);
#endif
