/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "flight/blackbox_capture.h"
#include "flight/flight_recorder.h"
#include <string.h>
#include <limits.h>
static uint64_t epoch,previous;
static uint32_t iteration;
static bool have_previous;
bool bb_capture_begin(uint32_t hz,uint64_t epoch_us){
 if(recorder_active())return false;
 recorder_reset();if(!recorder_start(hz))return false;
 epoch=epoch_us;previous=0;iteration=0;have_previous=false;pid_trace_enable(true);return true;
}
void bb_capture_end(void){recorder_stop();pid_trace_enable(false);}
void bb_capture_observe(uint64_t now,const float raw[3],const float filtered[3],
 const float setpoint[3],const pid_axis_out_t *output,const float motors[4],const float *rc,
 bool armed,uint8_t mode,uint8_t failsafe,bool gyro_valid,bool rx_fresh,bool output_healthy){
 if(!recorder_active())return;
 /* Preserve queued records on clock/session failure; never wrap timestamps. */
 if(now<epoch||now-epoch>UINT32_MAX||(have_previous&&now<=previous)||iteration==UINT32_MAX){bb_capture_end();return;}
 if(!raw||!filtered||!setpoint||!output||!motors){bb_capture_end();return;}
 flight_log_sample_t s={0};pid_trace_t trace;
 s.iteration=iteration++;s.time_us=(uint32_t)(now-epoch);
 s.dt_us=have_previous?(uint32_t)(now-previous):0;previous=now;have_previous=true;
 memcpy(s.gyro_raw,raw,sizeof s.gyro_raw);memcpy(s.gyro,filtered,sizeof s.gyro);
 memcpy(s.setpoint,setpoint,sizeof s.setpoint);memcpy(s.motor,motors,sizeof s.motor);
 if(rc)memcpy(s.rc,rc,sizeof s.rc);
 s.armed=armed;s.mode=mode;s.failsafe=failsafe;
 s.pid_valid=pid_trace_read(&trace);
 if(s.pid_valid){memcpy(s.p,trace.p,sizeof s.p);memcpy(s.i,trace.i,sizeof s.i);memcpy(s.d,trace.d,sizeof s.d);}
 s.pid_output[0]=output->roll;s.pid_output[1]=output->pitch;s.pid_output[2]=output->yaw;
 s.gyro_valid=gyro_valid;s.rx_fresh=rx_fresh&&rc!=NULL;s.output_healthy=output_healthy;
 (void)recorder_capture(&s);
}
