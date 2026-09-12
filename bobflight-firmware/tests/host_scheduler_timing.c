/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "sched/scheduler.h"
#include <stdio.h>
static uint64_t now;static unsigned gyro,pid,mix,filter,rx,fs,cli;
static uint32_t gyro_cost,filter_cost,pid_cost,mix_cost;
uint64_t hal_micros(void){return now;}
void loop_gyro(void){gyro++;now+=gyro_cost;}
void loop_filter(void){filter++;now+=filter_cost;}
void loop_pid(void){pid++;now+=pid_cost;}
void loop_mixer_dshot(void){mix++;now+=mix_cost;}
void bg_rx_poll(void){rx++;}void bg_failsafe_tick(void){fs++;}void bg_cli_poll(void){cli++;}
#define CHECK(x) do{if(!(x)){fprintf(stderr,"scheduler FAIL line %d: %s\n",__LINE__,#x);return 1;}}while(0)
int main(void){
 now=0;scheduler_init(1000,1);scheduler_run();const scheduler_stats_t *s=scheduler_stats();
 CHECK(gyro==1&&pid==1&&mix==1&&rx==1&&fs==1&&!s->gyro_interval_valid);
 now=999;scheduler_run();CHECK(gyro==1&&cli==1&&rx==3&&fs==3);
 now=1000;scheduler_run();CHECK(s->gyro_interval_last_us==1000&&s->gyro_jitter_max_us==0);
 now=3450;scheduler_run();CHECK(s->skipped_deadlines==1&&s->gyro_interval_last_us==2450&&s->start_lateness_max_us==1450);
 unsigned before=gyro;scheduler_run();CHECK(gyro==before);
 now=3999;scheduler_run();CHECK(gyro==before);now=4000;scheduler_run();CHECK(gyro==before+1);
 CHECK(s->gyro_interval_min_us==550&&s->gyro_interval_max_us==2450&&s->gyro_jitter_max_us==1450);
 now=0;gyro=pid=0;scheduler_init(8000,2);
 for(unsigned i=0;i<4;i++){now=i*125;scheduler_run();}
 CHECK(gyro==4&&pid==2&&s->pid_interval_last_us==250&&s->gyro_interval_last_us==125);
 now=1250;scheduler_run();CHECK(s->skipped_deadlines==6&&pid==2);
 now=1375;scheduler_run();CHECK(pid==3&&s->pid_interval_last_us==1000);
 now=0;gyro_cost=150;filter_cost=10;pid_cost=20;mix_cost=10;
 scheduler_init(8000,1);scheduler_run();CHECK(s->overruns==1&&s->gyro_exec_max_us==150&&s->cascade_exec_max_us==190);
 scheduler_run();CHECK(s->overruns==2);scheduler_run();CHECK(s->skipped_deadlines==1);
 gyro_cost=filter_cost=pid_cost=mix_cost=0;
 now=0xffffffffull-100;scheduler_init(1000,1);scheduler_run();now+=1000;scheduler_run();
 CHECK(s->gyro_interval_last_us==1000&&s->skipped_deadlines==0);
 scheduler_init(0,0);CHECK(s->gyro_hz==8000&&s->pid_process_denom==2&&s->gyro_runs==0&&s->overruns==0);
 scheduler_init(1000001,1);CHECK(s->gyro_period_us==125);
 puts("PASS scheduler: sub-ms cadence, divider, phase preservation, skipped slots/no replay, jitter, execution/overrun counters, RX/failsafe ordering, 32-bit time boundary and reset");return 0;
}
