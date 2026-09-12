/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "hal/hal.h"
#include "sched/scheduler.h"
#include <stdio.h>
#include <string.h>
static scheduler_stats_t stats;static char output[2048];static uint64_t now;
const scheduler_stats_t *scheduler_stats(void){return &stats;}
uint64_t hal_micros(void){return now;}
uint32_t hal_core_clock_hz(void){return 168000000;}
bool hal_time_high_resolution(void){return true;}
const char *hal_time_source(void){return "dwt-cyccnt";}
static void cli_write_str(const char *s){strncat(output,s,sizeof output-strlen(output)-1);}
#include "drivers/timing_cli.h"
#define CHECK(x) do{if(!(x)){fprintf(stderr,"timing CLI FAIL %d\n",__LINE__);return 1;}}while(0)
int main(void){
 stats.gyro_hz=1000;stats.gyro_period_us=1000;stats.pid_process_denom=2;
 cmd_timing();CHECK(strstr(output,"gyro_task_hz: unavailable")&&strstr(output,"timing_end: 1\r\n"));
 now=2000000;stats.gyro_runs=1800;stats.pid_runs=900;output[0]=0;cmd_timing();
 CHECK(strstr(output,"gyro_task_hz: 900.00")&&strstr(output,"pid_task_hz: 450.00"));
 CHECK(strstr(output,"core_clock_config_hz: 168000000")&&strstr(output,"timebase: dwt-cyccnt"));
 memset(&stats,255,sizeof stats);stats.gyro_interval_valid=stats.pid_interval_valid=true;stats.started_us=0;
 output[0]=0;now=UINT64_MAX;cmd_timing();CHECK(strstr(output,"timing_end: 1\r\n")&&!strstr(output,"overflow"));
 puts("PASS timing CLI: bounded complete framing, warmup unavailable, observed vs configured rates and wide counters");return 0;
}
