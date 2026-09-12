/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "drivers/gyro.h"
#include "flight/arming.h"
#include "flight/attitude.h"
#include "sched/tasks.h"
#include "hal/hal.h"
#include <stdio.h>
#include <string.h>
static char output[4096];static unsigned started,captured,applied,cancelled,last_face;
static bool usb=true,healthy=true,motor=false;static arm_state_t arm=ARM_DISARMED;
static bool report=false;
static uint32_t now=1000;static gyro_diagnostics_t diag={.sample_seq=1,.sample_ms=1000,.config_ok=true,.gyro_config=0x18,.accel_config=0x10,.chip="MPU6K-class"};
static float rates[3],accel[3]={0,0,1};
static void cli_write_str(const char *s){strncat(output,s,sizeof(output)-strlen(output)-1);}
uint32_t hal_millis(void){return now;}
bool hal_usb_cdc_connected(void){return usb;}
arm_state_t arming_state(void){return arm;}
bool bench_motor_active(void){return motor;}
bool gyro_is_healthy(void){return healthy;}
bool gyro_calibrated(void){return true;}
const gyro_diagnostics_t *gyro_diagnostics(void){return &diag;}
const float *gyro_latest_dps(void){return rates;}
const float *gyro_accel_g(void){return accel;}
const float *attitude_degrees(void){return rates;}
bool attitude_ready(void){return true;}
void gyro_calibration_tick(void){}
void gyro_calibration_touch(void){}
bool gyro_manual_calibration_active(void){return false;}
void gyro_calibration_info(gyro_calibration_info_t *c){memset(c,0,sizeof(*c));c->state="idle";c->reason="idle";c->face=-1;for(int i=0;i<3;i++)c->accel_scale[i]=1;
 if(report){c->faces=63;c->candidate_valid=true;c->apply_detail="Pair +X/-X, axis Y: midpoint=+0.1 g, limit=0.05 g";
 for(unsigned f=0;f<6;f++)for(unsigned a=0;a<3;a++)c->face_mean[f][a]=a==f/2?((f&1)?-1.f:1.f):0.f;
 for(unsigned a=0;a<3;a++)c->candidate_scale[a]=1.f;}}
bool gyro_start_manual_calibration(void){started++;return true;}
bool gyro_start_accel_calibration(void){started++;return true;}
bool gyro_capture_accel_face(unsigned f){captured++;last_face=f;return true;}
bool gyro_apply_accel_calibration(void){applied++;return true;}
void gyro_cancel_manual_calibration(void){cancelled++;}
#include "drivers/sensor_cli.h"
#define CHECK(x) do{if(!(x)){fprintf(stderr,"FAIL sensor CLI line %d: %s\n",__LINE__,#x);return 1;}}while(0)
static bool command(const char *s){output[0]=0;return cmd_sensor_command(s);}
int main(void){
 CHECK(command("sensors"));CHECK(strstr(output,"sensors_end: 1\r\n"));CHECK(strstr(output,"sensor_age_ms: 0\r\n"));CHECK(strstr(output,"cal_manual: no"));
 CHECK(strstr(output,"cal_bench_relaxed: no"));
 CHECK(command("calibration"));CHECK(strstr(output,"calibration_end: 1\r\n"));CHECK(strstr(output,"mpu_accel_config: 0x10"));CHECK(strstr(output,"ram-only"));
 CHECK(strstr(output,"cal_diagnostics_version: 1")&&strstr(output,"cal_raw_face_0: uncaptured"));
 report=true;CHECK(command("calibration"));
 CHECK(strstr(output,"cal_apply_detail: Pair +X/-X, axis Y"));
 CHECK(strstr(output,"cal_raw_face_5: 0.000000 0.000000 -1.000000"));
 CHECK(strstr(output,"cal_candidate_valid: yes")&&strstr(output,"cal_candidate_scale: 1.000000 1.000000 1.000000"));
 CHECK(strlen(output)<2048&&strstr(output,"calibration_end: 1"));
 report=false;
 CHECK(command("calibrate_gyro")&&started==1);CHECK(command("calibrate_accel start")&&started==2);
 const char *faces[]={"+x","-x","+y","-y","+z","-z"};
 for(unsigned i=0;i<6;i++){char cmd[40];snprintf(cmd,sizeof(cmd),"calibrate_accel %s",faces[i]);CHECK(command(cmd));CHECK(captured==i+1&&last_face==i);}
 CHECK(command("calibrate_accel apply")&&applied==1);
 const char *bad[]={"calibrate_accel +X","calibrate_accel +x extra","calibrate_accel 0","calibrate_accel start extra","calibrate_accel apply extra"};
 for(unsigned i=0;i<sizeof(bad)/sizeof(bad[0]);i++){CHECK(command(bad[i]));CHECK(strstr(output,"refused"));}
 CHECK(started==2&&captured==6&&applied==1);
 for(unsigned fault=0;fault<6;fault++){
  arm=ARM_DISARMED;usb=true;motor=false;healthy=true;diag.config_ok=true;diag.sample_ms=now;
  if(fault==0)arm=ARM_ARMED;
  if(fault==1)motor=true;
  if(fault==2)usb=false;
  if(fault==3)healthy=false;
  if(fault==4)diag.config_ok=false;
  if(fault==5)diag.sample_ms=now-101;
  CHECK(command("calibrate_gyro"));CHECK(strstr(output,"refused"));CHECK(started==2);
  CHECK(command("calibrate_accel +x"));CHECK(strstr(output,"refused"));CHECK(captured==6);
  CHECK(command("calibration_cancel"));CHECK(cancelled==fault+1);
 }
 puts("PASS: framed diagnostics, exact face mapping, invalid arguments, armed/motor/USB/health/config/stale refusal and unconditional cancel");return 0;
}
