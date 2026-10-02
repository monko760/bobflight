/* SPDX-License-Identifier: Apache-2.0 */
#include "flight/blackbox_capture.h"
#include "flight/flight_recorder.h"
#include "flight/config.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include <math.h>
static unsigned fills;
static void fill(bb_capture_extra_t *x){fills++;x->erpm[0]=4321u;x->erpm[1]=1;x->erpm[2]=2;x->telem_ok=0x7u;x->filter_flags=0x5Du;}
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
 /* Schema 3: decimate first (slow inputs read only for logged samples), events
  * latched across skipped loops, cleared only when a frame carrying them is queued. */
 assert(bb_capture_begin(500,0));fills=0;bb_capture_ctx_t ctx={4,false,1000,fill};
 bb_capture_observe_ex(0,raw,gyro,setpoint,&out,motor,rc,false,0,0,true,true,true,&ctx); /* baseline: no events invented */
 assert(recorder_pop(&s)&&s.events==0&&s.loop_code==4&&s.overruns==0&&fills==1);
 assert(s.erpm[0]==4321u&&s.erpm[3]==0u&&s.telem_ok==0x7u&&s.filter_flags==0x5Du);
 ctx.overruns_total=1004;ctx.loop_code=16;
 bb_capture_observe_ex(1000,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true,&ctx); /* skipped: arm+mode+loop */
 assert(fills==1&&!recorder_pop(&s)&&bb_capture_pending_events()==(BB_EVENT_ARM|BB_EVENT_MODE|BB_EVENT_LOOP_RATE));
 assert(recorder_stats()->total_skipped==1);
 bb_capture_observe_ex(2000,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true,&ctx);
 assert(recorder_pop(&s)&&fills==2&&s.events==(BB_EVENT_ARM|BB_EVENT_MODE|BB_EVENT_LOOP_RATE)&&s.loop_code==16&&s.overruns==4);
 assert(bb_capture_pending_events()==0);
 bb_capture_observe_ex(4000,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true,&ctx);assert(recorder_pop(&s)&&s.events==0);
 /* Queue full: the frame carrying the events is dropped, so they stay pending. */
 for(unsigned j=0;j<64;j++)bb_capture_observe_ex(6000+j*2000u,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true,&ctx);
 assert(recorder_stats()->queue_depth==64);ctx.telem_capture_failed=true;
 bb_capture_observe_ex(134000,raw,gyro,setpoint,&out,motor,NULL,false,1,1,true,false,true,&ctx); /* due but dropped */
 const uint8_t lost=BB_EVENT_DISARM|BB_EVENT_FAILSAFE_STAGE|BB_EVENT_RX_LOST|BB_EVENT_TELEM_CAPTURE_FAIL;
 assert(bb_capture_pending_events()==lost&&recorder_stats()->total_dropped==1);
 while(recorder_pop(&s));
 bb_capture_observe_ex(136000,raw,gyro,setpoint,&out,motor,NULL,false,1,1,true,false,true,&ctx);
 assert(recorder_pop(&s)&&s.events==lost&&s.dropped==1&&bb_capture_pending_events()==0);
 bb_capture_end();
 /* ctx NULL (legacy wrapper): schema 3 extras and loop code stay 0, arm/mode events still latch. */
 assert(bb_capture_begin(500,0));bb_capture_observe(0,raw,gyro,setpoint,&out,motor,rc,false,1,0,true,true,true);
 bb_capture_observe(2000,raw,gyro,setpoint,&out,motor,rc,true,1,0,true,true,true);
 assert(recorder_pop(&s)&&s.events==0&&recorder_pop(&s)&&s.events==BB_EVENT_ARM&&s.loop_code==0&&s.erpm[0]==0&&s.telem_ok==0&&s.filter_flags==0&&s.overruns==0);
 bb_capture_end();assert(recorder_pop(&s)==false);
 puts("PASS production capture observer: disabled no-op, trace equality, post-mixer command values, reset validity, independent timing, 500Hz decimation, bounded overflow and timestamp wrap stop; schema 3 decimate-first fill, event latch across skipped loops, kept on drop, cleared when queued, overrun delta");
}
