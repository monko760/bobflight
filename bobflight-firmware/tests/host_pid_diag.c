/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Deterministic time, fresh-sample and safety inputs. Axes 0/1/2=roll/pitch/yaw.
 */
#include "flight/pid_diag.h"
#include "flight/pid.h"
#include "flight/config.h"
#include "flight/rates.h"
#include "flight/arming.h"
#include "drivers/gyro.h"
#include <stdio.h>
#include <math.h>
#include <string.h>
#include <assert.h>
static uint64_t now=100000;
static bool usb=true,healthy=true,calibrated=true,manual=false,motor=false,rx_fresh=true;
static arm_state_t arm=ARM_DISARMED;
static float rc[16];static unsigned writes;
static gyro_diagnostics_t gd={.config_ok=true,.sample_seq=1,.sample_ms=100};
uint64_t hal_micros(void){return now;}
uint32_t hal_millis(void){return (uint32_t)(now/1000);}
bool hal_usb_cdc_connected(void){return usb;}
bool gyro_is_healthy(void){return healthy;}
bool gyro_calibrated(void){return calibrated;}
bool gyro_manual_calibration_active(void){return manual;}
const gyro_diagnostics_t *gyro_diagnostics(void){return &gd;}
bool bench_motor_active(void){return motor;}
arm_state_t arming_state(void){return arm;}
bool rx_frame_fresh(void){return rx_fresh;}
const float *rx_channels(void){return rc;}
void dshot_write(const float *v){(void)v;writes++;}
static void fresh(unsigned us){now+=us;gd.sample_ms=hal_millis();gd.sample_seq++;}
static pid_diag_snapshot_t snap(void){pid_diag_snapshot_t s;pid_diag_get_snapshot(&s);return s;}
static void tick(unsigned us,const float *g){fresh(us);pid_diag_update(now,g);}
static void near(float a,float b){assert(fabsf(a-b)<1e-6f);}
int main(void){
 config_init();pid_diag_init();float zero[3]={0},g[3]={10,-20,30};char text[1024];
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
 assert(!pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));assert(!pid_diag_start(PID_DIAG_SOURCE_RX,NULL));
 pid_diag_cli_process("pid_diag start",text,sizeof(text));assert(strstr(text,"flight-build-refused"));
 assert(!snap().active&&!snap().valid);assert(writes==0);puts("PASS PID diagnostic flight-build refusal");return 0;
#else
 assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,g);assert(!snap().valid);
 tick(1000,g);pid_diag_snapshot_t s=snap();assert(s.valid&&s.dt_us==1000&&s.sample_seq==1);near(s.correction[0],-.02001f);near(s.error_dps[1],20);assert(writes==0);
 // Production PID reference and shadow must agree; interleaving must not mutate either state.
 pid_axis_out_t expected[5],actual;float frames[5][3]={{1,2,3},{2,-3,4},{-5,0,10},{0,0,0},{4,5,6}};
 pid_init();for(unsigned i=0;i<5;i++){pid_set_dt(.001f);pid_update(frames[i],zero,&expected[i]);}
 pid_init();assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,zero);
 for(unsigned i=0;i<5;i++){
  tick(1000,frames[i]);s=snap();assert(s.valid);near(s.correction[0],expected[i].roll);near(s.correction[1],expected[i].pitch);near(s.correction[2],expected[i].yaw);
  pid_set_dt(.001f);pid_update(frames[i],zero,&actual);near(actual.roll,expected[i].roll);near(actual.pitch,expected[i].pitch);near(actual.yaw,expected[i].yaw);
 }
 // Diagnostic start/reset and stop must not reset production integrator or derivative history.
 pid_diag_stop(NULL);pid_update(zero,zero,&actual);pid_axis_out_t after=actual;
 pid_init();for(unsigned i=0;i<5;i++){pid_set_dt(.001f);pid_update(frames[i],zero,&actual);}pid_update(zero,zero,&actual);near(after.roll,actual.roll);near(after.pitch,actual.pitch);near(after.yaw,actual.yaw);
 // Receiver mapping is exactly existing rate mapping; no throttle/motor output.
 rc[0]=.5f;rc[1]=-.25f;rc[2]=.8f;rc[3]=0;float demand[3];rates_update(rc,demand);
 assert(pid_diag_start(PID_DIAG_SOURCE_RX,NULL));tick(1000,zero);tick(1000,zero);s=snap();assert(s.valid);for(unsigned i=0;i<3;i++)near(s.setpoint_dps[i],demand[i]);
 rx_fresh=false;pid_diag_get_snapshot(&s);assert(!s.active&&!s.valid);assert(!strcmp(s.reason,"receiver-stale"));near(s.correction[0],0);rx_fresh=true;
 // Timesteps 0, backwards, exact20ms and over20ms cannot reuse stale history.
 unsigned gaps[]={0,20000,25000};
 for(unsigned i=0;i<3;i++){assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,g);tick(gaps[i],g);s=snap();assert(!s.valid&&!strcmp(s.reason,"dt-invalid"));tick(1000,g);assert(!snap().valid);tick(1000,g);assert(snap().valid);}
 assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,g);now--;pid_diag_update(now,g);assert(!snap().valid);fresh(1000);
 assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,g);tick(19999,g);assert(snap().valid);
 // A current timestamp with repeated sensor sequence is NOT a fresh gyro sample.
 now+=1000;gd.sample_ms=hal_millis();pid_diag_update(now,g);assert(!snap().valid);assert(!strcmp(snap().reason,"gyro-no-new-sample"));
 assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,g);tick(1000,g);now+=21000;assert(!snap().valid&&!snap().active);fresh(1);
 // Snapshot validity also expires when producer task stalls despite fresh sensor metadata.
 assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,g);tick(1000,g);fresh(20000);assert(!snap().valid&&!strcmp(snap().reason,"diagnostic-stale"));
 float bad[3]={NAN,0,0};assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,bad);assert(!snap().valid);tick(1000,zero);tick(1000,zero);assert(snap().valid);
 // Every safety transition stops/invalidates, without arming or motor writes.
 bool *flags[]={&usb,&healthy,&calibrated,&manual,&motor};bool badflag[]={false,false,false,true,true};
 for(unsigned i=0;i<5;i++){fresh(1000);assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,g);tick(1000,g);bool old=*flags[i];*flags[i]=badflag[i];s=snap();assert(!s.active&&!s.valid);assert(!pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));*flags[i]=old;}
 fresh(1000);assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));arm=ARM_ARMED;s=snap();assert(!s.active&&!s.valid);assert(!pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));arm=ARM_DISARMED;
 fresh(1000);assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));fresh(60000000);assert(!snap().active&&!strcmp(snap().reason,"session-expired"));
 fresh(1000);assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));tick(1000,g);tick(1000,g);
 const char *invalid[]={"pid_diag start extra","pid_diag start rx extra","pid_diagxstart","start","pid_diag\narm","pid_diag start rx;arm"};
 for(unsigned i=0;i<sizeof(invalid)/sizeof(invalid[0]);i++){pid_diag_cli_process(invalid[i],text,sizeof(text));assert(strstr(text,"refused: invalid-command"));assert(snap().active&&snap().valid);}
 const char *ok[]={"pid_diag","pid_diag status","pid_diag start","pid_diag start rx","pid_diag stop"};
 for(unsigned i=0;i<5;i++){pid_diag_cli_process(ok[i],text,sizeof(text));assert(strstr(text,"pid_diag_end: 1"));assert(strstr(text,"motor_output: disabled"));assert(strlen(text)<sizeof(text)-1);}
 assert(!snap().active);assert(writes==0);assert(arm==ARM_DISARMED);puts("PASS shadow PID: original equation equivalence, independent state, rates, freshness/dt/reset guards, session safety, bounded CLI and no motor writes");return 0;
#endif
}
