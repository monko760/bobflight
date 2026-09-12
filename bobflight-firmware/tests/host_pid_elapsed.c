/* Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 * Real task-loop bench state machine with deterministic clock and mock outputs.
 * These tests do not validate physical timer/DMA operation or motor behavior.
 */
#include "sched/tasks.h"
#include "drivers/bench_parse.h"
#include "flight/arming.h"
#include "flight/failsafe.h"
#include "drivers/gyro.h"
#include "drivers/dshot.h"
#include "drivers/rx.h"
#include "drivers/cli.h"
#include "hal/hal.h"
#include <stdio.h>
#include <string.h>
#include <stdint.h>

static uint64_t now;
static bool usb=true, healthy=true, calibrating=false;
bool gyro_manual_calibration_active(void){return calibrating;}
void gyro_calibration_tick(void){}
static arm_state_t arm=ARM_DISARMED;
static float motors[4], rc[16], accel[3]={0,0,1};
uint32_t hal_millis(void){return (uint32_t)(now/1000u);}
uint64_t hal_micros(void){return now;}
bool hal_usb_cdc_connected(void){return usb;}
arm_state_t arming_state(void){return arm;}
void arming_disarm(void){arm=ARM_DISARMED;}
bool arming_try_arm(void){return false;}
const float *rx_channels(void){return rc;}
void rx_poll(void){}
void cli_poll(void){}
void failsafe_tick(uint32_t t){(void)t;}
bool failsafe_command_override(float s[4]){(void)s;return false;}
bool gyro_sample(float d[3]){memset(d,0,3*sizeof(float));return true;}
void gyro_filter(const float in[3],float out[3]){memcpy(out,in,3*sizeof(float));}
const float *gyro_accel_g(void){return accel;}
bool gyro_calibrated(void){return true;}
bool dshot_is_healthy(void){return healthy;}
void dshot_write(const float m[4]){memcpy(motors,m,sizeof(motors));}


#include "flight/pid.h"
#include <math.h>
static unsigned updates,sets,resets;static float measured_dt;
void pid_init(void){resets++;}
void pid_set_dt(float dt){sets++;measured_dt=dt;}
void pid_update(const float g[3],const float s[3],pid_axis_out_t *out){(void)g;(void)s;updates++;*out=(pid_axis_out_t){0};}
void mixer_update(const pid_axis_out_t *p,float t,float out[4]){(void)p;for(unsigned i=0;i<4;i++)out[i]=t;}
#define CHECK(c) do{if(!(c)){fprintf(stderr,"PID elapsed FAIL %d: %s\n",__LINE__,#c);return 1;}}while(0)
static void sample(uint64_t delta,bool pid){now+=delta;loop_gyro();loop_filter();if(pid)loop_pid();}
static void prime(void){
 arm=ARM_DISARMED;rc[3]=0;rc[4]=0;sample(1000,true);
 arm=ARM_ARMED;rc[3]=0.4f;sample(1000,true);
 updates=sets=0;
}
int main(void){
 /* Exercise the real task entrypoints with fake arm/PID endpoints, not flight. */
 for(unsigned div=1;div<=8;div*=2){
  prime();CHECK(updates==0);
  for(unsigned cycle=0;cycle<3;cycle++){
   for(unsigned i=1;i<=div;i++)sample(125,i==div);
   CHECK(updates==cycle+1 && sets==updates);
   CHECK(fabsf(measured_dt-(float)(125*div)*1e-6f)<1e-8f);
  }
 }
 prime();sample(1000,false);sample(1000,false);sample(1750,true);
 CHECK(updates==1 && fabsf(measured_dt-0.00375f)<1e-8f);
 /* Low throttle clears the timing epoch; raising it primes without update. */
 rc[3]=0;sample(1000,true);unsigned before=updates;
 rc[3]=0.4f;sample(1000,true);CHECK(updates==before);
 sample(1000,true);CHECK(updates==before+1&&fabsf(measured_dt-0.001f)<1e-8f);
 /* Timestamp zero is valid, never used as an initialization sentinel. */
 arm=ARM_DISARMED;loop_pid();now=0;loop_gyro();loop_gyro();arm=ARM_ARMED;rc[3]=0.4f;loop_pid();
 before=updates;sample(1000,true);CHECK(updates==before+1);
 /* Zero/backward/too-long PID intervals disarm and never call pid_set_dt. */
 prime();before=sets;loop_pid();CHECK(arm==ARM_DISARMED&&sets==before);
 prime();before=sets;now--;loop_pid();CHECK(arm==ARM_DISARMED&&sets==before);
 prime();before=sets;for(unsigned i=0;i<20;i++)sample(1000,false);
 loop_pid();CHECK(arm==ARM_DISARMED&&sets==before);
 /* Just inside the supported domain is accepted despite fresh gyro samples. */
 prime();for(unsigned i=0;i<19;i++)sample(1000,false);sample(999,true);
 CHECK(arm==ARM_ARMED && fabsf(measured_dt-0.019999f)<1e-8f);
 /* 64-bit timing crosses a 32-bit microsecond boundary without reset. */
 now=0xfffffff0ull;prime();sample(1000,true);CHECK(arm==ARM_ARMED&&fabsf(measured_dt-0.001f)<1e-8f);
 puts("PASS real PID task: dividers1/2/4/8, elapsed delays, first/zero epoch, low-throttle reset, invalid/gap disarm and 32-bit boundary");return 0;
}
