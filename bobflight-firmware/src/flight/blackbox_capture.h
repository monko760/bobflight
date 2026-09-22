/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_BLACKBOX_CAPTURE_H
#define BOBFLIGHT_BLACKBOX_CAPTURE_H
#include <stdbool.h>
#include <stdint.h>
#include "flight/pid.h"
/* Observer only: no I/O, arm/disarm, PID reset, or motor writes. */
bool bb_capture_begin(uint32_t hz,uint64_t epoch_us);
void bb_capture_end(void);
void bb_capture_observe(uint64_t pid_time_us,const float raw[3],const float filtered[3],
 const float setpoint[3],const pid_axis_out_t *output,const float motors[4],const float *rc,
 bool armed,uint8_t mode,uint8_t failsafe,bool gyro_valid,bool rx_fresh,bool output_healthy);
#endif
