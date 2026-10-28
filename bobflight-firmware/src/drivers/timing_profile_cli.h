/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_TIMING_PROFILE_CLI_H
#define BOBFLIGHT_TIMING_PROFILE_CLI_H
#include "sched/scheduler_profile.h"
static void cmd_timing_profile(const char *action){
 const char *refused=NULL;
 if(strcmp(action,"start")==0){
  if(!scheduler_profile_start())refused="busy, armed, motor-active, uninitialized or low-resolution-clock";
 }else if(strcmp(action,"stop")==0)scheduler_profile_stop();
 else if(*action)refused="unknown-action";
 scheduler_profile_stats_t s=*scheduler_profile_stats();
 static const char *names[PROFILE_STAGE_COUNT]={"gyro","filter","pid","motor_output","rx","failsafe","cli","outside_scheduler_gap"};
 char buf[1600];size_t used=0;int n;
#define PROFILE_APPEND(...) do { n=snprintf(buf+used,sizeof buf-used,__VA_ARGS__); \
 if(n<0 || (size_t)n>=sizeof buf-used){goto overflow;}used+=(size_t)n; }while(0)
 PROFILE_APPEND("timing_profile_version: 1\r\ntiming_profile_available: yes\r\n");
 if(refused)PROFILE_APPEND("timing_profile_refused: %s\r\n",refused);
 PROFILE_APPEND("profile_state: %s\r\nprofile_target_us: %u\r\nprofile_elapsed_us: %llu\r\n"
  "profile_gyro_hz: %lu\r\nprofile_pid_denom: %lu\r\nprofile_cost: elapsed-wall-time-including-interrupts\r\n",
  scheduler_profile_state_name(s.state),SCHEDULER_PROFILE_WINDOW_US,(unsigned long long)s.elapsed_us,
  (unsigned long)s.gyro_hz,(unsigned long)s.pid_denom);
 for(unsigned i=0;i<PROFILE_STAGE_COUNT;i++){
  const scheduler_profile_cost_t *c=&s.stages[i];char average[32];
  if(c->runs)snprintf(average,sizeof average,"%llu",(unsigned long long)(c->total_us/c->runs));
  else snprintf(average,sizeof average,"unavailable");
  PROFILE_APPEND("profile_%s: runs=%lu total_us=%llu max_us=%lu mean_us=%s\r\n",names[i],
   (unsigned long)c->runs,(unsigned long long)c->total_us,(unsigned long)c->max_us,average);
 }
 PROFILE_APPEND("timing_profile_end: 1\r\n");cli_write_str(buf);return;
overflow:
 cli_write_str("timing_profile_refused: response-overflow\r\ntiming_profile_end: 1\r\n");
#undef PROFILE_APPEND
}
#endif
