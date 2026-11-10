#ifndef BOBFLIGHT_SCHEDULER_PROFILE_IMPL_H
#define BOBFLIGHT_SCHEDULER_PROFILE_IMPL_H
/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Private scheduler implementation. No timers/IRQs/allocations; all work is
 * foreground-owned. The normal OFF path never reads the clock for profiling. */
static scheduler_profile_stats_t g_profile;
static uint64_t g_profile_generation;
static uint64_t g_profile_last_clock,g_profile_last_return;
static bool g_profile_have_return;
static bool profile_running(void){return g_profile.state==PROFILE_RUNNING;}
static void profile_finish(scheduler_profile_state_t state,uint64_t now){
 if(!profile_running())return;
 if(now>=g_profile.started_us)g_profile.elapsed_us=now-g_profile.started_us;
 g_profile.state=state;
}
const scheduler_profile_stats_t *scheduler_profile_stats(void){return &g_profile;}
const char *scheduler_profile_state_name(scheduler_profile_state_t state){
 switch(state){
 case PROFILE_OFF:return "off";case PROFILE_RUNNING:return "running";
 case PROFILE_COMPLETE:return "complete";case PROFILE_STOPPED:return "stopped";
 case PROFILE_ARMED:return "armed";case PROFILE_MOTOR_ACTIVE:return "motor-active";
 case PROFILE_CLOCK_INVALID:return "clock-invalid";case PROFILE_RATE_CHANGED:return "rate-changed";
 default:return "invalid";
 }
}
static bool profile_safe(uint64_t now){
 if(!profile_running())return false;
 if(now<g_profile_last_clock || !hal_time_high_resolution()){
  profile_finish(PROFILE_CLOCK_INVALID,g_profile_last_clock);return false;
 }
 g_profile_last_clock=now;g_profile.elapsed_us=now-g_profile.started_us;
 if(arming_state()!=ARM_DISARMED){profile_finish(PROFILE_ARMED,now);return false;}
 if(bench_motor_active()){profile_finish(PROFILE_MOTOR_ACTIVE,now);return false;}
 return true;
}
bool scheduler_profile_start(void){
 if(profile_running() || !g_stats.gyro_period_us || !hal_time_high_resolution() ||
    arming_state()!=ARM_DISARMED || bench_motor_active())return false;
 uint64_t now=hal_micros();
 g_profile_generation++;
 g_profile=(scheduler_profile_stats_t){0};g_profile.state=PROFILE_RUNNING;
 g_profile.started_us=now;g_profile.gyro_hz=g_stats.gyro_hz;g_profile.pid_denom=g_stats.pid_process_denom;
 g_profile_last_clock=now;g_profile_have_return=false;return true;
}
void scheduler_profile_stop(void){
 if(profile_running()){
  uint64_t now=hal_micros();if(profile_safe(now))profile_finish(PROFILE_STOPPED,now);
 }
}
static void profile_record(scheduler_profile_stage_t stage,uint64_t start,uint64_t end){
 if(!profile_running())return;
 if(start<g_profile_last_clock || end<start){profile_finish(PROFILE_CLOCK_INVALID,g_profile_last_clock);return;}
 if(!profile_safe(end))return;
 scheduler_profile_cost_t *cost=&g_profile.stages[stage];uint64_t duration=end-start;
 if(cost->runs<UINT32_MAX)cost->runs++;
 cost->total_us=UINT64_MAX-cost->total_us<duration?UINT64_MAX:cost->total_us+duration;
 maximum(&cost->max_us,duration);
 if(g_profile.elapsed_us>=SCHEDULER_PROFILE_WINDOW_US)profile_finish(PROFILE_COMPLETE,end);
}
static bool profile_enter(void){
 if(!profile_running())return false;
 uint64_t before=g_profile_last_clock,now=hal_micros();
 if(!profile_safe(now))return false;
 if(g_profile_have_return){
  /* This is a gap between scheduler calls, not CPU utilization. */
  g_profile_last_clock=before;
  profile_record(PROFILE_OUTSIDE_GAP,g_profile_last_return,now);
 }
 if(profile_running() && g_profile.elapsed_us>=SCHEDULER_PROFILE_WINDOW_US)profile_finish(PROFILE_COMPLETE,now);
 return profile_running();
}
static void profile_leave(void){
 if(!profile_running())return;
 uint64_t now=hal_micros();if(!profile_safe(now))return;
 g_profile_last_return=now;g_profile_have_return=true;
 if(g_profile.elapsed_us>=SCHEDULER_PROFILE_WINDOW_US)profile_finish(PROFILE_COMPLETE,now);
}
#define PROFILE_CALL(stage,call) do { \
 if(profile && profile_generation==g_profile_generation && profile_running()){uint64_t t=hal_micros();call; \
  if(profile_generation==g_profile_generation && profile_running())profile_record(stage,t,hal_micros());} \
 else {call;} \
} while(0)

#endif
