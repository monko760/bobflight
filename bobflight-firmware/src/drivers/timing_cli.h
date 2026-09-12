/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_TIMING_CLI_H
#define BOBFLIGHT_TIMING_CLI_H
/* Private bounded read-only command. Task invocation rates are NOT the MPU
 * fresh-sample rate, ESC packet rate, or proof of successful PID updates. */
static void cmd_timing(void){
 const scheduler_stats_t *p=scheduler_stats();
 if(!p){cli_write_str("timing_available: no\r\ntiming_end: 1\r\n");return;}
 scheduler_stats_t s=*p;uint64_t now=hal_micros();
 uint64_t elapsed=now>=s.started_us?now-s.started_us:0;
 char rates[140],buf[1500];
 if(elapsed>=1000000u)snprintf(rates,sizeof rates,"gyro_task_hz: %.2f\r\npid_task_hz: %.2f\r\n",
  (double)s.gyro_runs*1000000.0/(double)elapsed,(double)s.pid_runs*1000000.0/(double)elapsed);
 else snprintf(rates,sizeof rates,"gyro_task_hz: unavailable\r\npid_task_hz: unavailable\r\n");
 int n=snprintf(buf,sizeof buf,
  "timing_version: 1\r\ntiming_available: yes\r\ntimebase: %s\r\ntime_high_resolution: %s\r\n"
  "core_clock_config_hz: %lu\r\ngyro_config_hz: %lu\r\ngyro_period_us: %lu\r\npid_denom: %lu\r\n"
  "rates_window: since-scheduler-init\r\nrates_elapsed_us: %llu\r\n%s"
  "gyro_task_runs: %llu\r\npid_task_runs: %llu\r\nskipped_gyro_slots: %llu\r\ncycle_overruns: %llu\r\n"
  "gyro_interval_valid: %s\r\ngyro_interval_last_us: %lu\r\ngyro_interval_min_us: %lu\r\ngyro_interval_max_us: %lu\r\n"
  "pid_interval_valid: %s\r\npid_interval_last_us: %lu\r\npid_interval_min_us: %lu\r\npid_interval_max_us: %lu\r\n"
  "gyro_jitter_max_us: %lu\r\npid_jitter_max_us: %lu\r\nstart_lateness_max_us: %lu\r\n"
  "gyro_exec_max_us: %lu\r\ncascade_exec_max_us: %lu\r\ntiming_end: 1\r\n",
  hal_time_source(),hal_time_high_resolution()?"yes":"no",(unsigned long)hal_core_clock_hz(),
  (unsigned long)s.gyro_hz,(unsigned long)s.gyro_period_us,(unsigned long)s.pid_process_denom,
  (unsigned long long)elapsed,rates,(unsigned long long)s.gyro_runs,(unsigned long long)s.pid_runs,
  (unsigned long long)s.skipped_deadlines,(unsigned long long)s.overruns,
  s.gyro_interval_valid?"yes":"no",(unsigned long)s.gyro_interval_last_us,(unsigned long)s.gyro_interval_min_us,(unsigned long)s.gyro_interval_max_us,
  s.pid_interval_valid?"yes":"no",(unsigned long)s.pid_interval_last_us,(unsigned long)s.pid_interval_min_us,(unsigned long)s.pid_interval_max_us,
  (unsigned long)s.gyro_jitter_max_us,(unsigned long)s.pid_jitter_max_us,(unsigned long)s.start_lateness_max_us,
  (unsigned long)s.gyro_exec_max_us,(unsigned long)s.cascade_exec_max_us);
 if(n<0 || (size_t)n>=sizeof buf){cli_write_str("timing response failed: overflow\r\n");return;}
 cli_write_str(buf);
}
#endif
