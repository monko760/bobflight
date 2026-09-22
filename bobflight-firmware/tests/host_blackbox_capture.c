/* SPDX-License-Identifier: Apache-2.0 */
#include "flight/blackbox_capture.h"
#include "flight/flight_recorder.h"
#include "flight/config.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
int main(void){
 config_init();pid_init();float raw[3]={1,2,3},gyro[3]={.5f,1,2},setpoint[3]={20,10,5},motor[4]={.1f,.2f,.3f,.4f},rc[4]={.1f,.2f,.3f,.4f};
 pid_axis_out_t out={0};flight_log_sample_t s;pid_trace_t trace;
 bb_capture_observe(0,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true);assert(!recorder_pop(&s));
 assert(bb_capture_begin(500,10000));assert(!bb_capture_begin(500,10000));
 pid_set_dt(.001f);pid_update(gyro,setpoint,&out);assert(pid_trace_read(&trace));
 bb_capture_observe(11000,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true);
 assert(recorder_pop(&s));assert(s.time_us==1000&&s.iteration==0&&s.pid_valid&&s.gyro_valid&&s.rx_fresh&&s.output_healthy);assert(s.dt_us==0);
 assert(!memcmp(s.p,trace.p,sizeof s.p));assert(!memcmp(s.i,trace.i,sizeof s.i));assert(!memcmp(s.d,trace.d,sizeof s.d));assert(s.pid_output[0]==out.roll);assert(!memcmp(s.motor,motor,sizeof motor));
 bb_capture_observe(12000,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true);assert(!recorder_pop(&s));
 pid_init();out=(pid_axis_out_t){0};bb_capture_observe(13000,raw,gyro,setpoint,&out,motor,NULL,false,1,2,false,false,false);
 assert(recorder_pop(&s));assert(s.iteration==2&&s.dt_us==1000&&!s.pid_valid&&!s.rx_fresh&&!s.gyro_valid&&!s.output_healthy);assert(s.failsafe==2&&s.p[0]==0&&s.i[0]==0&&s.d[0]==0&&s.pid_output[0]==0);
 bb_capture_observe(12000,raw,gyro,setpoint,&out,motor,rc,false,1,0,true,true,true);assert(!recorder_active());assert(!pid_trace_read(&trace));
 assert(bb_capture_begin(500,0));for(unsigned j=0;j<70;j++)bb_capture_observe(j*2000u,raw,gyro,setpoint,&out,motor,rc,false,1,0,true,true,true);
 assert(recorder_stats()->queue_depth==64&&recorder_stats()->total_dropped==6);bb_capture_end();assert(recorder_pop(&s));
 assert(bb_capture_begin(500,0));bb_capture_observe((uint64_t)UINT32_MAX+1,raw,gyro,setpoint,&out,motor,rc,false,1,0,true,true,true);assert(!recorder_active());
 puts("PASS production capture observer: disabled no-op, trace equality, post-mixer command values, reset validity, independent timing, 500Hz decimation, bounded overflow and timestamp wrap stop");
}
