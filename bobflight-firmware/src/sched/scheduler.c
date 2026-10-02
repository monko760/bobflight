/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Cooperative, phase-preserving deadlines; skipped slots are counted, never
 * replayed as synthetic sensor samples. Stats are foreground-owned snapshots.
 */
#include "sched/scheduler.h"
#include "sched/tasks.h"
#include "hal/hal.h"
#include <limits.h>
static scheduler_stats_t g_stats;
static uint32_t g_pid_remaining;
static uint64_t g_next_gyro_us,g_last_gyro_us,g_last_pid_us;
static uint32_t bounded(uint64_t n){return n>UINT32_MAX?UINT32_MAX:(uint32_t)n;}
static void maximum(uint32_t *dst,uint64_t value){if(value>*dst)*dst=bounded(value);}
static void interval(uint64_t now,uint64_t before,uint64_t expected,bool *valid,
 uint32_t *last,uint32_t *min,uint32_t *max,uint32_t *jitter){
 uint64_t dt=now-before;*last=bounded(dt);
 if(!*valid || dt<*min)*min=bounded(dt);
 maximum(max,dt);maximum(jitter,dt>expected?dt-expected:expected-dt);*valid=true;
}
static uint32_t per_second(uint64_t runs,uint64_t elapsed){
 return elapsed?bounded((runs*1000000u+elapsed/2u)/elapsed):0;
}
static void sanitize(uint32_t *gyro_hz,uint32_t *pid_process_denom){
 if(*gyro_hz==0 || *gyro_hz>1000000u)*gyro_hz=SCHEDULER_DEFAULT_GYRO_HZ;
 if(*pid_process_denom==0)*pid_process_denom=SCHEDULER_DEFAULT_PID_DENOM;
}
static void window_restart(uint64_t now){
 g_stats.loop_window_start_us=now;g_stats.loop_window_open_runs=0;
 g_stats.loop_window_open_gyro=g_stats.loop_window_open_overruns=0;
}
/* Close the ~1 s window at the first gyro slot at/after its end. The slot
 * that closes it belongs to the next window. */
static void window_roll(uint64_t now){
 uint64_t elapsed=now-g_stats.loop_window_start_us;
 if(elapsed<SCHEDULER_LOOP_WINDOW_US)return;
 g_stats.loop_actual_hz=per_second(g_stats.loop_window_open_runs,elapsed);
 g_stats.loop_window_gyro_runs=g_stats.loop_window_open_gyro;
 g_stats.loop_window_overruns=g_stats.loop_window_open_overruns;
 g_stats.loop_actual_valid=true;g_stats.loop_window_seq++;
 window_restart(now);
}
void scheduler_init(uint32_t gyro_hz,uint32_t pid_process_denom){
 sanitize(&gyro_hz,&pid_process_denom);
 g_stats=(scheduler_stats_t){0};g_stats.gyro_hz=gyro_hz;
 g_stats.pid_process_denom=pid_process_denom;g_stats.gyro_period_us=1000000u/gyro_hz;
 /* The first gyro slot runs the full cascade (motors get a real frame at
  * once); afterwards every pid_process_denom-th slot. */
 g_pid_remaining=1u;g_last_gyro_us=g_last_pid_us=0;
 g_stats.started_us=hal_micros();g_next_gyro_us=g_stats.started_us;
 window_restart(g_stats.started_us);
}
void scheduler_set_rate(uint32_t gyro_hz,uint32_t pid_process_denom){
 sanitize(&gyro_hz,&pid_process_denom);
 if(!g_stats.gyro_period_us){scheduler_init(gyro_hz,pid_process_denom);return;}
 if(gyro_hz==g_stats.gyro_hz && pid_process_denom==g_stats.pid_process_denom)return;
 uint64_t now=hal_micros();
 g_stats.gyro_hz=gyro_hz;g_stats.pid_process_denom=pid_process_denom;
 g_stats.gyro_period_us=1000000u/gyro_hz;g_pid_remaining=1u;
 /* Rate-relative statistics restart; since-boot fault counters do not. */
 g_stats.started_us=now;g_stats.gyro_runs=g_stats.pid_runs=0;
 g_stats.gyro_interval_valid=g_stats.pid_interval_valid=false;
 g_stats.gyro_interval_last_us=g_stats.gyro_interval_min_us=g_stats.gyro_interval_max_us=0;
 g_stats.pid_interval_last_us=g_stats.pid_interval_min_us=g_stats.pid_interval_max_us=0;
 g_stats.gyro_jitter_max_us=g_stats.pid_jitter_max_us=g_stats.start_lateness_max_us=0;
 g_stats.loop_actual_valid=false;g_stats.loop_actual_hz=0;g_stats.loop_window_seq=0;
 g_stats.loop_window_gyro_runs=g_stats.loop_window_overruns=0;
 window_restart(now);g_stats.rate_changes++;
 g_next_gyro_us=now;
}
void scheduler_run(void){
 /* Receiver/failsafe ordering remains unchanged; other agent owns that work. */
 bg_rx_poll();bg_failsafe_tick();
 uint64_t now=hal_micros();
 if(now>=g_next_gyro_us){
  window_roll(now);
  uint64_t late=now-g_next_gyro_us;
  uint64_t skipped=late>=g_stats.gyro_period_us?late/g_stats.gyro_period_us:0;
  g_stats.skipped_deadlines+=skipped;maximum(&g_stats.start_lateness_max_us,late);
  g_next_gyro_us+=(skipped+1u)*g_stats.gyro_period_us;
  if(g_stats.gyro_runs)interval(now,g_last_gyro_us,g_stats.gyro_period_us,
   &g_stats.gyro_interval_valid,&g_stats.gyro_interval_last_us,&g_stats.gyro_interval_min_us,
   &g_stats.gyro_interval_max_us,&g_stats.gyro_jitter_max_us);
  g_last_gyro_us=now;g_stats.gyro_runs++;g_stats.loop_window_open_gyro++;
  uint64_t gyro_start=hal_micros();loop_gyro();
  maximum(&g_stats.gyro_exec_max_us,hal_micros()-gyro_start);
  /* Safety S1: gyro LPF + notches on EVERY gyro sample, so a PID divider
   * (8000/2) never drops a sample unfiltered (no aliasing of HF noise). */
  loop_filter();
  if(--g_pid_remaining==0){
   g_pid_remaining=g_stats.pid_process_denom;
   uint64_t pid_start=hal_micros();
   if(g_stats.pid_runs)interval(pid_start,g_last_pid_us,(uint64_t)g_stats.gyro_period_us*g_stats.pid_process_denom,
    &g_stats.pid_interval_valid,&g_stats.pid_interval_last_us,&g_stats.pid_interval_min_us,
    &g_stats.pid_interval_max_us,&g_stats.pid_jitter_max_us);
   g_last_pid_us=pid_start;g_stats.pid_runs++;
   loop_pid();loop_mixer_dshot();g_stats.cascade_runs++;g_stats.loop_window_open_runs++;
  }
  uint64_t duration=hal_micros()-now;
  maximum(&g_stats.cascade_exec_max_us,duration);
  if(duration>g_stats.gyro_period_us){g_stats.overruns++;g_stats.loop_window_open_overruns++;}
  return;
 }
 bg_rx_poll();bg_cli_poll();bg_failsafe_tick();g_stats.bg_runs++;
}
const scheduler_stats_t *scheduler_stats(void){return &g_stats;}
uint32_t scheduler_loop_target_hz(void){
 return g_stats.pid_process_denom?g_stats.gyro_hz/g_stats.pid_process_denom:0;
}
bool scheduler_loop_actual_hz(uint64_t now,uint32_t *hz){
 if(!hz || !g_stats.gyro_period_us || now<g_stats.loop_window_start_us)return false;
 uint64_t open=now-g_stats.loop_window_start_us;
 if(open>=2ull*SCHEDULER_LOOP_WINDOW_US){*hz=per_second(g_stats.loop_window_open_runs,open);return true;}
 if(!g_stats.loop_actual_valid)return false;
 *hz=g_stats.loop_actual_hz;return true;
}
uint32_t scheduler_bg_budget_us(uint64_t now){
 if(!g_stats.gyro_period_us)return SCHEDULER_BG_UNSCHEDULED_US;
 if(now>=g_next_gyro_us)return 0;
 uint64_t left=g_next_gyro_us-now;
 if(left<=SCHEDULER_BG_GUARD_US)return 0;
 left-=SCHEDULER_BG_GUARD_US;
 return left>SCHEDULER_BG_MAX_US?SCHEDULER_BG_MAX_US:(uint32_t)left;
}
