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
void scheduler_init(uint32_t gyro_hz,uint32_t pid_process_denom){
 if(gyro_hz==0 || gyro_hz>1000000u)gyro_hz=8000;
 if(pid_process_denom==0)pid_process_denom=2;
 g_stats=(scheduler_stats_t){0};g_stats.gyro_hz=gyro_hz;
 g_stats.pid_process_denom=pid_process_denom;g_stats.gyro_period_us=1000000u/gyro_hz;
 g_pid_remaining=pid_process_denom;g_last_gyro_us=g_last_pid_us=0;
 g_stats.started_us=hal_micros();g_next_gyro_us=g_stats.started_us;
}
void scheduler_run(void){
 /* Receiver/failsafe ordering remains unchanged; other agent owns that work. */
 bg_rx_poll();bg_failsafe_tick();
 uint64_t now=hal_micros();
 if(now>=g_next_gyro_us){
  uint64_t late=now-g_next_gyro_us;
  uint64_t skipped=late>=g_stats.gyro_period_us?late/g_stats.gyro_period_us:0;
  g_stats.skipped_deadlines+=skipped;maximum(&g_stats.start_lateness_max_us,late);
  g_next_gyro_us+=(skipped+1u)*g_stats.gyro_period_us;
  if(g_stats.gyro_runs)interval(now,g_last_gyro_us,g_stats.gyro_period_us,
   &g_stats.gyro_interval_valid,&g_stats.gyro_interval_last_us,&g_stats.gyro_interval_min_us,
   &g_stats.gyro_interval_max_us,&g_stats.gyro_jitter_max_us);
  g_last_gyro_us=now;g_stats.gyro_runs++;
  uint64_t gyro_start=hal_micros();loop_gyro();
  maximum(&g_stats.gyro_exec_max_us,hal_micros()-gyro_start);
  if(--g_pid_remaining==0){
   g_pid_remaining=g_stats.pid_process_denom;
   loop_filter();uint64_t pid_start=hal_micros();
   if(g_stats.pid_runs)interval(pid_start,g_last_pid_us,(uint64_t)g_stats.gyro_period_us*g_stats.pid_process_denom,
    &g_stats.pid_interval_valid,&g_stats.pid_interval_last_us,&g_stats.pid_interval_min_us,
    &g_stats.pid_interval_max_us,&g_stats.pid_jitter_max_us);
   g_last_pid_us=pid_start;g_stats.pid_runs++;
   loop_pid();loop_mixer_dshot();g_stats.cascade_runs++;
  }
  uint64_t duration=hal_micros()-now;
  maximum(&g_stats.cascade_exec_max_us,duration);
  if(duration>g_stats.gyro_period_us)g_stats.overruns++;
  return;
 }
 bg_rx_poll();bg_cli_poll();bg_failsafe_tick();g_stats.bg_runs++;
}
const scheduler_stats_t *scheduler_stats(void){return &g_stats;}
