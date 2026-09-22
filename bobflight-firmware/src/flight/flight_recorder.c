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
 if(!s||s->armed>1u||s->mode>2u||s->failsafe>2u||s->pid_valid>1u||s->gyro_valid>1u||s->rx_fresh>1u||s->output_healthy>1u)return false;
 for(unsigned a=0;a<3;a++){
  if(!isfinite(s->gyro_raw[a])||!isfinite(s->gyro[a])||!isfinite(s->setpoint[a])||!isfinite(s->p[a])||!isfinite(s->i[a])||!isfinite(s->d[a])||!isfinite(s->pid_output[a]))return false;
  if(!isfinite(s->rc[a])||s->rc[a]<-1.f||s->rc[a]>1.f)return false;
 }
 for(unsigned m=0;m<4;m++)if(!isfinite(s->motor[m])||s->motor[m]<0.f||s->motor[m]>1.f)return false;
 return isfinite(s->rc[3])&&s->rc[3]>=0.f&&s->rc[3]<=1.f;
}
void recorder_reset(void){
 if(active)return;
 head=tail=count=period=last_time=last_iteration=0;next_due=0;have_time=false;
 memset(&stats,0,sizeof stats);stats.queue_capacity=FLIGHT_RECORDER_QUEUE_CAPACITY;
}
bool recorder_start(uint32_t hz){
 if(active||count||(hz!=250u&&hz!=500u&&hz!=1000u))return false;
 recorder_reset();period=1000000u/hz;stats.rate_hz=hz;active=true;return true;
}
void recorder_stop(void){active=false;}
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
 last_time=s->time_us;last_iteration=s->iteration;
 if(!have_time){next_due=s->time_us;have_time=true;}
 if((uint64_t)s->time_us<next_due){inc(&stats.total_skipped);return false;}
 /* Use 64-bit deadline arithmetic and O(1) catch-up. A session ending near
  * UINT32_MAX cannot wrap this deadline into an infinite catch-up loop. */
 uint64_t missed=((uint64_t)s->time_us-next_due)/period;
 plus(&stats.total_missed,missed);next_due+=(missed+1u)*period;
 if(count==FLIGHT_RECORDER_QUEUE_CAPACITY){inc(&stats.total_dropped);return false;}
 queue[head]=*s;queue[head].dropped=stats.total_dropped;
 head=(head+1u)%FLIGHT_RECORDER_QUEUE_CAPACITY;++count;stats.queue_depth=count;inc(&stats.total_accepted);return true;
}
const flight_recorder_stats_t *recorder_stats(void){return &stats;}
