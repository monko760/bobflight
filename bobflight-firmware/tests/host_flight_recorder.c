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
 /* 125 Hz support and deterministic in-session lowering (never raising). */
 init();assert(recorder_start(125));recorder_stop();recorder_reset();
 init();assert(!recorder_lower_rate(250));assert(recorder_start(500));assert(!recorder_lower_rate(500)&&!recorder_lower_rate(1000)&&!recorder_lower_rate(300));
 s.time_us=0;s.iteration=0;assert(recorder_capture(&s));s.time_us=2000;s.iteration=1;assert(recorder_capture(&s));
 assert(recorder_lower_rate(250)&&recorder_stats()->rate_hz==250);
 s.time_us=4000;s.iteration=2;assert(recorder_capture(&s)); /* existing deadline kept */
 s.time_us=6000;s.iteration=3;assert(!recorder_capture(&s)); /* decimated at 4 ms period */
 s.time_us=8000;s.iteration=4;assert(recorder_capture(&s));
 assert(recorder_lower_rate(125)&&!recorder_lower_rate(250)&&recorder_stats()->rate_hz==125);
 s.time_us=12000;s.iteration=5;assert(recorder_capture(&s));s.time_us=16000;s.iteration=6;assert(!recorder_capture(&s));s.time_us=20000;s.iteration=7;assert(recorder_capture(&s));
 recorder_stop();assert(!recorder_lower_rate(125));
 /* Decimate-first (schema 3 capture): recorder_skip_if_not_due() answers "not due"
  * with the same counters capture() would, so skipped loops never build a sample. */
 {const uint32_t rates[]={1000,500,250,125};
  for(unsigned r=0;r<4;r++){flight_recorder_stats_t a,b;uint32_t popped_a=0,popped_b=0;
   for(unsigned pass=0;pass<2;pass++){
    init();recorder_stop();assert(recorder_start(rates[r]));uint32_t popped=0;
    assert(!recorder_skip_if_not_due(0,0)); /* first sample establishes the clock */
    for(uint32_t n=0;n<4000;n++){
     s.iteration=n;s.time_us=n*125u+(n%7u==3u?40u:0u); /* 8 kHz with jitter */
     if(pass&&recorder_skip_if_not_due(s.time_us,s.iteration))continue;
     (void)recorder_capture(&s);
     if(recorder_stats()->queue_depth>32){assert(recorder_pop(&out));popped++;}
    }
    while(recorder_pop(&out))popped++;
    if(pass){b=*recorder_stats();popped_b=popped;}else{a=*recorder_stats();popped_a=popped;}
    recorder_stop();
   }
   assert(a.total_attempted==b.total_attempted&&a.total_skipped==b.total_skipped&&a.total_accepted==b.total_accepted);
   assert(a.total_missed==b.total_missed&&a.total_dropped==b.total_dropped&&popped_a==popped_b&&a.total_dropped==0);
   assert(a.total_accepted>=4000u*125u*rates[r]/1000000u-1u);
  }
  /* Never skips when due, inactive, before the first sample, or on regression. */
  init();assert(!recorder_skip_if_not_due(5,5));assert(recorder_start(500));assert(!recorder_skip_if_not_due(0,0));
  s.time_us=1000;s.iteration=1;assert(recorder_capture(&s));
  assert(recorder_skip_if_not_due(1500,2)&&recorder_stats()->total_skipped==1&&recorder_stats()->total_attempted==2);
  assert(!recorder_skip_if_not_due(1400,3)); /* time regressed: capture() must count it */
  assert(!recorder_skip_if_not_due(1600,1)); /* iteration regressed */
  assert(!recorder_skip_if_not_due(3000,4)); /* due */
  recorder_stop();assert(!recorder_skip_if_not_due(3100,5));}
 /* QA #62 F2: scheduler jitter at the deadline must not lose a slot. Loops on a
  * phase-preserving grid start late by 0..J us (the first one anchors the log
  * grid); a loop that lands a few us BEFORE the logging deadline is still due. */
 {static const struct {uint32_t loop_hz,log_hz,jitter;} cases[]={
   {1000,1000,25},{1000,1000,400},{1000,500,25},{4000,1000,20},{4000,500,20},{8000,1000,20},{8000,500,20},{8000,125,20}};
  for(unsigned c=0;c<sizeof cases/sizeof cases[0];c++){
   const uint32_t lp=1000000u/cases[c].loop_hz,n_loops=cases[c].loop_hz*10u,ratio=cases[c].loop_hz/cases[c].log_hz;uint32_t seed=12345u+c,popped=0;
   init();assert(recorder_start(cases[c].log_hz));
   for(uint32_t n=0;n<n_loops;n++){
    seed=seed*1103515245u+12345u;const uint32_t late=n?(seed>>16)%(cases[c].jitter+1u):cases[c].jitter/2u;
    s.iteration=n;s.time_us=n*lp+late;
    if(recorder_skip_if_not_due(s.time_us,s.iteration))continue;
    (void)recorder_capture(&s);while(recorder_pop(&out))popped++;
   }
   const flight_recorder_stats_t *st=recorder_stats();
   if(st->total_missed||st->total_accepted+1u<n_loops/ratio||st->total_accepted>n_loops/ratio+1u){
    printf("jitter case %u: %u Hz loop, %u Hz log, jitter %u: accepted %u missed %u (want %u, 0)\n",c,(unsigned)cases[c].loop_hz,(unsigned)cases[c].log_hz,(unsigned)cases[c].jitter,(unsigned)st->total_accepted,(unsigned)st->total_missed,(unsigned)(n_loops/ratio));assert(0);}
   assert(st->total_dropped==0&&popped==st->total_accepted&&st->total_skipped+st->total_accepted==n_loops);
   recorder_stop();
  }}
 /* Early tolerance is strictly < half of the loop interval: the loop nearest the deadline. */
 init();assert(recorder_start(1000));s.time_us=0;s.iteration=0;assert(recorder_capture(&s));
 for(uint32_t k=1;k<=7;k++)assert(recorder_skip_if_not_due(125u*k-62u,k));      /* 8 kHz grid, 62 us phase */
 s.time_us=938;s.iteration=8;assert(!recorder_skip_if_not_due(938,8)&&recorder_capture(&s)); /* 8 kHz: 62 us early, dt 125: due */
 recorder_stop();
 init();assert(recorder_start(1000));s.time_us=0;s.iteration=0;assert(recorder_capture(&s));
 for(uint32_t k=1;k<=7;k++)assert(recorder_skip_if_not_due(125u*k-63u,k));      /* 8 kHz grid, 63 us phase */
 s.time_us=937;s.iteration=8;assert(recorder_skip_if_not_due(937,8));             /* 63 us early, dt 125: not nearest */
 s.time_us=1062;s.iteration=9;assert(recorder_capture(&s));assert(recorder_stats()->total_missed==0);
 recorder_stop();
 init();assert(recorder_start(1000));s.time_us=0;s.iteration=0;assert(recorder_capture(&s));
 s.time_us=980;s.iteration=1;assert(recorder_capture(&s));                        /* 20 us early, dt 980: due */
 assert(recorder_pop(&out)&&recorder_pop(&out)&&out.time_us==980);                /* true timestamp kept */
 s.time_us=1005;s.iteration=2;assert(!recorder_capture(&s));                      /* slot 1000 already filled */
 s.time_us=1999;s.iteration=3;assert(recorder_capture(&s));                       /* 1 us early: due */
 s.time_us=2999;s.iteration=4;assert(recorder_capture(&s));
 s.time_us=3500;s.iteration=5;assert(!recorder_capture(&s));                      /* 500 us early, dt 501: no */
 s.time_us=3999;s.iteration=6;assert(recorder_capture(&s));
 assert(recorder_stats()->total_missed==0&&recorder_stats()->total_accepted==5&&recorder_stats()->total_skipped==2);
 recorder_stop();
 /* Tie (exactly dt/2 early) waits for the on-time loop: 500 Hz log over a 1 kHz grid. */
 init();assert(recorder_start(500));s.time_us=0;s.iteration=0;assert(recorder_capture(&s));
 s.time_us=500;s.iteration=1;assert(!recorder_capture(&s));
 s.time_us=1500;s.iteration=2;assert(recorder_skip_if_not_due(1500,2));            /* 500 early, dt 1000: tie */
 s.time_us=2500;s.iteration=3;assert(recorder_capture(&s));assert(recorder_pop(&out)&&recorder_pop(&out)&&out.time_us==2500);
 assert(recorder_stats()->total_missed==0);
 recorder_stop();
 /* A real stall still counts every empty slot: loops 0..5000, then nothing until 10000. */
 init();assert(recorder_start(1000));
 for(uint32_t n=0;n<=5;n++){s.iteration=n;s.time_us=n*1000u;assert(recorder_capture(&s));}
 s.time_us=10000;s.iteration=8;assert(recorder_capture(&s));assert(recorder_stats()->total_missed==4); /* 6000..9000 */
 s.time_us=11000;s.iteration=9;assert(recorder_capture(&s));assert(recorder_stats()->total_missed==4);
 /* Late loop after a stall (scheduler runs the late slot): 3 empty slots, the late loop fills 15000. */
 s.time_us=15580;s.iteration=10;assert(recorder_capture(&s));assert(recorder_stats()->total_missed==7);
 s.time_us=16000;s.iteration=11;assert(recorder_capture(&s));assert(recorder_stats()->total_missed==7);
 recorder_stop();
 puts("PASS recorder: FIFO/retention; 125/250/500/1000Hz; in-session lower-only rate; O(1) missed slots; invalid/regressed inputs; timestamp extremes; cumulative loss; decimate-first skip matches capture() counters at 1000/500/250/125 Hz; deadline jitter never misses a slot at 1k/4k/8k loops (early tolerance < half the loop interval), real stalls still counted as missed");
}
