/* SPDX-License-Identifier: Apache-2.0 */
#include "flight/flight_recorder.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <limits.h>
static flight_log_sample_t s;
static void init(void){recorder_stop();recorder_reset();s=(flight_log_sample_t){.dt_us=1000,.armed=1,.mode=1};}
int main(void){
 init();assert(!recorder_start(0));assert(!recorder_start(2000));assert(recorder_start(500));assert(!recorder_start(500));
 assert(recorder_capture(&s));s.time_us=1000;s.iteration++;assert(!recorder_capture(&s));s.time_us=2000;s.iteration++;assert(recorder_capture(&s));
 s.time_us=9000;s.iteration=9;assert(recorder_capture(&s));assert(recorder_stats()->total_missed==2);assert(recorder_stats()->total_skipped==1);
 flight_log_sample_t out;assert(recorder_pop(&out)&&out.time_us==0);assert(recorder_pop(&out)&&out.time_us==2000);assert(recorder_pop(&out)&&out.time_us==9000);assert(!recorder_pop(&out));
 recorder_reset();assert(recorder_active());assert(recorder_stats()->total_accepted==3);recorder_stop();assert(!recorder_capture(&s));assert(recorder_start(250));assert(recorder_stats()->total_accepted==0);
 init();assert(recorder_start(1000));
 for(unsigned n=0;n<64;n++){s.iteration=n;s.time_us=n*1000;assert(recorder_capture(&s));}
 s.iteration=64;s.time_us=64000;assert(!recorder_capture(&s));assert(recorder_stats()->total_dropped==1);recorder_stop();assert(!recorder_start(500));
 for(unsigned n=0;n<64;n++){assert(recorder_pop(&out));assert(out.iteration==n&&out.time_us==n*1000);}
 assert(recorder_start(1000));assert(recorder_stats()->total_dropped==0);recorder_stop();
 init();assert(recorder_start(1000));for(unsigned n=0;n<64;n++){s.iteration=n;s.time_us=n*1000;assert(recorder_capture(&s));}
 s.iteration=64;s.time_us=64000;assert(!recorder_capture(&s));assert(recorder_pop(&out));s.iteration=65;s.time_us=65000;assert(recorder_capture(&s));
 for(unsigned n=1;n<64;n++)assert(recorder_pop(&out));assert(recorder_pop(&out)&&out.dropped==1);
 s.iteration=66;s.time_us=66000;assert(recorder_capture(&s));assert(recorder_pop(&out)&&out.dropped==1);
 s.motor[0]=NAN;s.iteration++;s.time_us+=1000;assert(!recorder_capture(&s));s.motor[0]=0;s.rc[3]=1.01f;assert(!recorder_capture(&s));s.rc[3]=0;assert(!recorder_capture(NULL));assert(!recorder_pop(NULL));
 init();assert(recorder_start(1000));s.time_us=12345;s.iteration=3;assert(recorder_capture(&s));assert(recorder_pop(&out)&&out.time_us==12345);s.time_us=12000;assert(!recorder_capture(&s));s.time_us=14000;s.iteration=2;assert(!recorder_capture(&s));assert(recorder_stats()->total_regressed==2);
 s.iteration=4000000;s.time_us=UINT32_MAX-1;assert(recorder_capture(&s));assert(recorder_pop(&out)&&out.time_us==UINT32_MAX-1);s.time_us=UINT32_MAX;assert(!recorder_capture(&s));s.time_us=0;assert(!recorder_capture(&s));assert(recorder_stats()->total_regressed==3);
 init();assert(recorder_start(500));s.time_us=UINT32_MAX;assert(recorder_capture(&s));assert(recorder_pop(&out)&&out.time_us==UINT32_MAX);assert(!recorder_capture(&s));
 puts("PASS recorder: FIFO/retention; 250/500/1000Hz; O(1) missed slots; invalid/regressed inputs; timestamp extremes; cumulative loss");
}
