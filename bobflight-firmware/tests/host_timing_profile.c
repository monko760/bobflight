/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "sched/scheduler.h"
#include "sched/scheduler_profile.h"
#include "flight/arming.h"
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>
static uint64_t now;static unsigned reads;static bool hires=true,motor,arm_in_pid;
static arm_state_t arm=ARM_DISARMED;
static bool restart_in_cli,restart_ok;
static bool zero_cost;static char order[64];static unsigned order_len;
static void step(char name,unsigned cost){if(order_len<sizeof order-1){order[order_len++]=name;order[order_len]=0;}if(!zero_cost)now+=cost;}
static unsigned gyro,filter,pid,mix,rx,fs,cli;
uint64_t hal_micros(void){reads++;return now;}
bool hal_time_high_resolution(void){return hires;}
arm_state_t arming_state(void){return arm;}
bool bench_motor_active(void){return motor;}
void loop_gyro(void){gyro++;step('g',10);}
void loop_filter(void){filter++;step('f',20);}
void loop_pid(void){pid++;step('p',30);if(arm_in_pid)arm=ARM_ARMED;}
void loop_mixer_dshot(void){mix++;step('m',40);}
void bg_rx_poll(void){rx++;step('r',5);}
void bg_failsafe_tick(void){fs++;step('s',7);}
void bg_cli_poll(void){cli++;step('c',11);if(restart_in_cli){scheduler_profile_stop();restart_ok=scheduler_profile_start();}}
static char output[2048];
static void cli_write_str(const char *s){strncat(output,s,sizeof output-strlen(output)-1);}
#include "drivers/timing_profile_cli.h"
#define CHECK(x) do{if(!(x)){fprintf(stderr,"profile FAIL %d: %s\n",__LINE__,#x);return 1;}}while(0)
static void reset(void){restart_in_cli=restart_ok=false;zero_cost=false;order_len=0;order[0]=0;now=100;hires=true;motor=false;arm_in_pid=false;arm=ARM_DISARMED;gyro=filter=pid=mix=rx=fs=cli=0;scheduler_init(1000,2);reads=0;output[0]=0;}
int main(void){
 CHECK(!scheduler_profile_start()); /* not initialized */
 reset();scheduler_run();CHECK(reads==5);CHECK(gyro==1&&filter==1&&pid==1&&mix==1);
 now=250;reads=0;scheduler_run();CHECK(reads==1&&rx==3&&fs==3&&cli==1);
 now=1100;reads=0;scheduler_run();CHECK(reads==4&&gyro==2&&filter==2&&pid==1&&mix==1);
 CHECK(scheduler_profile_stats()->state==PROFILE_OFF); /* OFF has exactly baseline clock reads */
 for(unsigned hz=1000;hz<=8000;hz*=2)for(unsigned div=1;div<=8;div*=2){
  reset();zero_cost=true;scheduler_init(hz,div);
  for(unsigned slot=0;slot<=div;slot++){
   now=100+(uint64_t)slot*(1000000u/hz);reads=0;order_len=0;order[0]=0;
   scheduler_run();bool full=slot%div==0;
   CHECK(reads==(full?5u:4u));CHECK(!strcmp(order,full?"rsgfpm":"rsgf"));
   now++;reads=0;order_len=0;order[0]=0;scheduler_run();CHECK(reads==1&&!strcmp(order,"rsrcs"));
  }
 }
 reset();arm=ARM_ARMED;CHECK(!scheduler_profile_start());arm=ARM_DISARMED;
 motor=true;CHECK(!scheduler_profile_start());motor=false;hires=false;CHECK(!scheduler_profile_start());hires=true;
 CHECK(scheduler_profile_start());CHECK(!scheduler_profile_start());scheduler_run();
 const scheduler_profile_stats_t *p=scheduler_profile_stats();
 CHECK(p->state==PROFILE_RUNNING&&p->elapsed_us==112);
 CHECK(p->stages[PROFILE_GYRO].runs==1&&p->stages[PROFILE_GYRO].max_us==10);
 CHECK(p->stages[PROFILE_FILTER].total_us==20&&p->stages[PROFILE_PID].total_us==30&&p->stages[PROFILE_MOTOR_OUTPUT].total_us==40);
 now=250;scheduler_run();CHECK(rx==3&&fs==3&&cli==1);
 CHECK(p->stages[PROFILE_RX].runs==3&&p->stages[PROFILE_RX].total_us==15);
 CHECK(p->stages[PROFILE_FAILSAFE].runs==3&&p->stages[PROFILE_FAILSAFE].total_us==21);
 CHECK(p->stages[PROFILE_CLI].total_us==11&&p->stages[PROFILE_OUTSIDE_GAP].total_us==38);
 now=1100;scheduler_run();CHECK(p->stages[PROFILE_FILTER].runs==2&&p->stages[PROFILE_PID].runs==1);
 cmd_timing_profile("");CHECK(strstr(output,"profile_filter: runs=2 total_us=40 max_us=20 mean_us=20"));
 CHECK(strstr(output,"timing_profile_end: 1\r\n")&&!strstr(output,"response-overflow"));
 output[0]=0;cmd_timing_profile("start");CHECK(strstr(output,"timing_profile_refused:")&&p->stages[PROFILE_FILTER].runs==2);
 now=p->started_us+SCHEDULER_PROFILE_WINDOW_US;scheduler_run();CHECK(p->state==PROFILE_COMPLETE);
 uint32_t saved=p->stages[PROFILE_FILTER].runs;scheduler_run();CHECK(p->stages[PROFILE_FILTER].runs==saved);
 reset();CHECK(scheduler_profile_start());now+=SCHEDULER_PROFILE_WINDOW_US-1;scheduler_run();
 CHECK(p->state==PROFILE_COMPLETE&&p->elapsed_us==SCHEDULER_PROFILE_WINDOW_US+4);
 CHECK(p->stages[PROFILE_RX].runs==1&&p->stages[PROFILE_FILTER].runs==0); /* callback boundary, not preemption */
 reset();CHECK(scheduler_profile_start());scheduler_run();scheduler_profile_stop();CHECK(p->state==PROFILE_STOPPED);
 reads=0;scheduler_profile_stop();CHECK(reads==0); /* stopped is inert */
 reset();CHECK(scheduler_profile_start());arm=ARM_ARMED;scheduler_run();CHECK(p->state==PROFILE_ARMED);
 reset();CHECK(scheduler_profile_start());motor=true;scheduler_run();CHECK(p->state==PROFILE_MOTOR_ACTIVE);
 reset();CHECK(scheduler_profile_start());arm_in_pid=true;scheduler_run();CHECK(p->state==PROFILE_ARMED);
 CHECK(mix==1&&p->stages[PROFILE_MOTOR_OUTPUT].runs==0); /* real task still runs, no intrusive profiling */
 reset();CHECK(scheduler_profile_start());hires=false;scheduler_run();CHECK(p->state==PROFILE_CLOCK_INVALID);
 reset();CHECK(scheduler_profile_start());now--;scheduler_run();CHECK(p->state==PROFILE_CLOCK_INVALID&&p->elapsed_us==0);
 reset();CHECK(scheduler_profile_start());scheduler_run();scheduler_set_rate(1000,2);CHECK(p->state==PROFILE_RUNNING);
 scheduler_set_rate(8000,1);CHECK(p->state==PROFILE_RATE_CHANGED&&p->gyro_hz==1000&&p->pid_denom==2);
 CHECK(scheduler_stats()->gyro_hz==8000); /* never restores or overrides rate policy */
 reset();CHECK(scheduler_profile_start());scheduler_run();uint64_t old_start=p->started_us;
 now=250;restart_in_cli=true;scheduler_run();CHECK(restart_ok&&p->state==PROFILE_RUNNING&&p->started_us>old_start);
 for(unsigned i=0;i<PROFILE_STAGE_COUNT;i++)CHECK(p->stages[i].runs==0); /* never charge old callback to new session */
 restart_in_cli=false;now++;scheduler_run();CHECK(p->state==PROFILE_RUNNING&&p->stages[PROFILE_RX].runs>0);
 reset();CHECK(scheduler_profile_start());scheduler_init(1000,1);CHECK(p->state==PROFILE_OFF);
 output[0]=0;cmd_timing_profile("start extra");CHECK(strstr(output,"unknown-action")&&strstr(output,"timing_profile_end: 1"));
 output[0]=0;cmd_timing_profile("");CHECK(strstr(output,"mean_us=unavailable"));
 scheduler_profile_stats_t *wide=(scheduler_profile_stats_t*)p;
 wide->state=PROFILE_COMPLETE;wide->elapsed_us=UINT64_MAX;wide->gyro_hz=wide->pid_denom=UINT32_MAX;
 for(unsigned i=0;i<PROFILE_STAGE_COUNT;i++)wide->stages[i]=(scheduler_profile_cost_t){UINT64_MAX,UINT32_MAX,UINT32_MAX};
 output[0]=0;cmd_timing_profile("");CHECK(strlen(output)<1600&&strstr(output,"timing_profile_end: 1")&&!strstr(output,"response-overflow"));
 puts("PASS bounded profiling: exact stage/gap costs, divider/order, zero extra OFF timestamps, expiry/refusals/auto-stop, rate changes and complete bounded CLI");return 0;
}
