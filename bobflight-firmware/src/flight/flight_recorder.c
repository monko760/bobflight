/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Foreground cooperative FIFO: capture and pop are not ISR/thread safe.
 * Capture never performs I/O, allocates, or loops over elapsed time. */
#include "flight/flight_recorder.h"
#include <math.h>
#include <stddef.h>
#include <string.h>
#include <limits.h>
static flight_log_sample_t queue[FLIGHT_RECORDER_QUEUE_CAPACITY];
static uint32_t head,tail,count,period,last_time,last_iteration;
static uint64_t next_due;
static bool active,have_time;
static flight_recorder_stats_t stats={.queue_capacity=FLIGHT_RECORDER_QUEUE_CAPACITY};
static void inc(uint32_t *v){if(*v<UINT32_MAX)++*v;}
static void plus(uint32_t *v,uint64_t n){*v=n>UINT32_MAX-*v?UINT32_MAX:*v+(uint32_t)n;}
static bool valid(const flight_log_sample_t *s){
 if(!flight_log_sample_flags_valid(s))return false;
 for(unsigned a=0;a<3;a++){
  if(!isfinite(s->gyro_raw[a])||!isfinite(s->gyro[a])||!isfinite(s->setpoint[a])||!isfinite(s->p[a])||!isfinite(s->i[a])||!isfinite(s->d[a])||!isfinite(s->pid_output[a]))return false;
  if(!isfinite(s->rc[a])||s->rc[a]<-1.f||s->rc[a]>1.f)return false;
 }
 for(unsigned a=0;a<3;a++){
  if((s->accel_valid&&!isfinite(s->accel_g[a]))||(s->attitude_valid&&(!isfinite(s->attitude_deg[a])||fabsf(s->attitude_deg[a])>360.f)))return false;
 }
 for(unsigned m=0;m<4;m++)if(!isfinite(s->motor[m])||s->motor[m]<0.f||s->motor[m]>1.f)return false;
 return isfinite(s->rc[3])&&s->rc[3]>=0.f&&s->rc[3]<=1.f&&isfinite(s->setpoint_throttle)&&s->setpoint_throttle>=0.f&&s->setpoint_throttle<=1.f;
}
void recorder_reset(void){
 if(active)return;
 head=tail=count=period=last_time=last_iteration=0;next_due=0;have_time=false;
 memset(&stats,0,sizeof stats);stats.queue_capacity=FLIGHT_RECORDER_QUEUE_CAPACITY;
}
/* Is a loop at t (>= last_time, clock established) due for next_due? A loop is
 * due at or after the deadline, or EARLY by less than half of this loop's
 * interval (dt): it is then nearer the deadline than the next loop, expected
 * about dt later. Without this, a log period equal to the loop period lost a
 * slot whenever scheduler jitter put a loop a few us before the deadline (BB1
 * QA F2: 1000/1 at 1000 Hz logged ~799 Hz with 3,703 "missed" slots). A tie
 * (exactly dt/2 early) waits for the on-time loop. An accepted loop is never
 * early by period/2 or more (by induction: dt is measured from a loop at or
 * after the last accepted one, itself early by < period/2), each acceptance
 * advances next_due by >= one period so a slot never takes two loops, and
 * accepted samples keep their true timestamps (nothing is re-timed). */
static bool due(uint32_t t){
 if((uint64_t)t>=next_due)return true;
 return (next_due-t)*2u<(uint64_t)(t-last_time);
}
static bool supported(uint32_t hz){return hz==125u||hz==250u||hz==500u||hz==1000u;}
bool recorder_start(uint32_t hz){
 if(active||count||!supported(hz))return false;
 recorder_reset();period=1000000u/hz;stats.rate_hz=hz;active=true;return true;
}
void recorder_stop(void){active=false;}
/* Deterministic in-session decimation: only ever lowers the rate. The next
 * accepted slot keeps the existing deadline; later slots use the new period.
 * Queued samples are untouched; no sample is fabricated or re-timed. */
bool recorder_lower_rate(uint32_t hz){
 if(!active||!supported(hz)||hz>=stats.rate_hz)return false;
 period=1000000u/hz;stats.rate_hz=hz;return true;
}
bool recorder_active(void){return active;}
bool recorder_pop(flight_log_sample_t *s){
 if(!s||!count)return false;
 *s=queue[tail];tail=(tail+1u)%FLIGHT_RECORDER_QUEUE_CAPACITY;--count;stats.queue_depth=count;return true;
}
bool recorder_capture(const flight_log_sample_t *s){
 if(!active)return false;
 inc(&stats.total_attempted);
 if(!valid(s)){inc(&stats.total_invalid);inc(&stats.total_dropped);return false;}
 if(have_time&&(s->time_us<last_time||s->iteration<last_iteration)){
  inc(&stats.total_regressed);inc(&stats.total_dropped);return false;
 }
 const bool first=!have_time;
 if(!first&&!due(s->time_us)){last_time=s->time_us;last_iteration=s->iteration;inc(&stats.total_skipped);return false;}
 last_time=s->time_us;last_iteration=s->iteration;
 if(first){next_due=s->time_us;have_time=true;}
 /* Use 64-bit deadline arithmetic and O(1) catch-up. A session ending near
  * UINT32_MAX cannot wrap this deadline into an infinite catch-up loop. An
  * early (in-tolerance) sample fills next_due itself: nothing was missed. */
 uint64_t missed=(uint64_t)s->time_us>next_due?((uint64_t)s->time_us-next_due)/period:0u;
 plus(&stats.total_missed,missed);next_due+=(missed+1u)*period;
 if(count==FLIGHT_RECORDER_QUEUE_CAPACITY){inc(&stats.total_dropped);return false;}
 queue[head]=*s;queue[head].dropped=stats.total_dropped;
 head=(head+1u)%FLIGHT_RECORDER_QUEUE_CAPACITY;++count;stats.queue_depth=count;inc(&stats.total_accepted);return true;
}
bool recorder_skip_if_not_due(uint32_t t,uint32_t it){
 if(!active||!have_time||t<last_time||it<last_iteration||due(t))return false;
 inc(&stats.total_attempted);last_time=t;last_iteration=it;inc(&stats.total_skipped);return true;
}
const flight_recorder_stats_t *recorder_stats(void){return &stats;}
