/* Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 * Real scheduler driving the real task bodies: the PID uses the running loop
 * rate (8000/2 -> 250 us) and the soft gyro LPF runs on every gyro sample at
 * the gyro period (8000/2 -> 125 us, safety S1), never a fixed constant.
 * Deterministic clock and mock outputs; not a hardware timing claim. */
#include "sched/tasks.h"
#include "sched/scheduler.h"
#include "flight/arming.h"
#include "flight/mode_range.h"
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
bool rx_frame_fresh(void){return true;}
void rx_poll(void){}
void cli_poll(void){}
void failsafe_tick(uint32_t t){(void)t;}
bool failsafe_command_override(float s[4]){(void)s;return false;}
bool gyro_sample(float d[3]){memset(d,0,3*sizeof(float));return true;}
void gyro_filter(const float in[3],float out[3]){memcpy(out,in,3*sizeof(float));}
const float *gyro_accel_g(void){return accel;}
bool gyro_calibrated(void){return true;}
bool gyro_flight_ready(void){return true;}
bool dshot_is_healthy(void){return healthy;}
void dshot_write(const float m[4]){memcpy(motors,m,sizeof(motors));}


#include "flight/pid.h"
#include "flight/config.h"
#include <math.h>
static unsigned updates,sets,resets;static float measured_dt;
void pid_init(void){resets++;}
void pid_set_dt(float dt){sets++;measured_dt=dt;}
void pid_update(const float g[3],const float s[3],pid_axis_out_t *out){(void)g;(void)s;updates++;*out=(pid_axis_out_t){0};}
void mixer_update(const pid_axis_out_t *p,float t,float out[4]){(void)p;for(unsigned i=0;i<4;i++)out[i]=t;}
static float filter_dt;static unsigned filter_sets;
void gyro_filter_set_dt(float dt){filter_dt=dt;filter_sets++;}
#define CHECK(c) do{if(!(c)){fprintf(stderr,"loop dt FAIL %d: %s\n",__LINE__,#c);return 1;}}while(0)
static bool near(float a,float b){return fabsf(a-b)<1e-9f;}
static void run_until(uint64_t end){while(now<end){scheduler_run();if(now<end)now++;}}
static int check_rate(uint32_t gyro_hz,uint32_t denom,float want_dt){
 const float want_filter_dt=1.f/(float)gyro_hz;unsigned long runs0;
 arm=ARM_DISARMED;rc[3]=0;rc[4]=0;now=1000;scheduler_init(gyro_hz,denom);
 run_until(now+20000);                      /* disarmed: witness low arm input */
 arm=ARM_ARMED;rc[4]=1;rc[3]=0.4f;updates=sets=filter_sets=0;runs0=scheduler_stats()->gyro_runs;
 run_until(now+200000);
 /* S1: one filter update per gyro sample (not per PID cycle), at 1/gyro_hz. */
 CHECK(filter_sets==scheduler_stats()->gyro_runs-runs0&&near(filter_dt,want_filter_dt));
 CHECK(updates>0&&sets==updates&&near(measured_dt,want_dt));
 return 0;
}
int main(void){
 mode_range_init();config_init();
 if(check_rate(8000,2,250e-6f))return 1;   /* Kakute: 4 kHz PID */
 if(check_rate(4000,2,500e-6f))return 1;   /* overrun-guard 2 kHz */
 if(check_rate(1000,1,1000e-6f))return 1;  /* other boards / legacy */
 /* Runtime rate change: the next PID cycles follow the new period. */
 if(check_rate(8000,2,250e-6f))return 1;
 scheduler_set_rate(4000,2);updates=sets=0;run_until(now+100000);
 CHECK(near(filter_dt,250e-6f)&&updates>0&&near(measured_dt,500e-6f));
 puts("PASS loop dt: real tasks under real scheduler use PID dt 250 us (8000/2), 500 us (4000/2), 1 ms (1000/1); the gyro LPF runs on every gyro sample at 125/250/1000 us; both follow runtime rate changes");
 return 0;
}
