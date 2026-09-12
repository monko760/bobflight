/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "drivers/sensor_calibration.h"
#include <stdio.h>
#include <math.h>
#include <string.h>
#define CHECK(x) do{if(!(x)){fprintf(stderr,"FAIL calibration line %d: %s\n",__LINE__,#x);return 1;}}while(0)
static void feed(sensor_calibration_t *c,float g[3],float a[3],uint32_t *now,unsigned n){
 for(unsigned i=0;i<n;i++)sc_feed(c,g,a,++*now);
}
int main(void){
 sensor_calibration_t c;uint32_t now=0;float g[3]={1,-2,.5f},a[3]={0,0,1};
 sc_init(&c);sc_begin_gyro(&c,now);
 feed(&c,g,a,&now,1000);CHECK(!c.gyro_valid);
 feed(&c,g,a,&now,1);CHECK(c.gyro_valid&&c.mode==SC_COMPLETE);
 CHECK(fabsf(c.gyro_bias[0]-1)<1e-5f&&fabsf(c.gyro_bias[1]+2)<1e-5f);
 sc_begin_gyro(&c,now);for(int i=0;i<2000;i++)sc_feed(&c,g,a,now);CHECK(c.samples==1);
 g[0]=6;feed(&c,g,a,&now,1);CHECK(c.samples==0);g[0]=1;
 a[2]=.82f;feed(&c,g,a,&now,1100);CHECK(c.gyro_valid&&c.mode==SC_COMPLETE&&!c.accel_valid);a[2]=1;
 sc_begin_gyro(&c,now);
 sc_tick(&c,c.phase_started+30000u);CHECK(c.mode==SC_ERROR&&c.gyro_bias[0]==1);
 sc_begin_gyro(&c,now);g[0]=NAN;feed(&c,g,a,&now,1);CHECK(c.mode==SC_ERROR);g[0]=1;
 sc_begin_gyro(&c,now);feed(&c,g,a,&now,600);now+=21;feed(&c,g,a,&now,1);CHECK(c.samples==1);
 sc_cancel(&c,"cancelled");CHECK(c.gyro_valid&&c.gyro_bias[0]==1);
 /* Millisecond wrap cannot accelerate or prevent a stationary window. */
 now=UINT32_MAX-500u;sc_begin_gyro(&c,now);feed(&c,g,a,&now,1001);CHECK(c.mode==SC_COMPLETE);
 sc_begin_gyro(&c,now);
 for(unsigned i=0;i<1100;i++){g[0]=(i&1)?1.f:-1.f;sc_feed(&c,g,a,++now);}
 CHECK(c.mode==SC_GYRO&&c.samples<1000);g[0]=1;
 /* Six known raw faces: measurement = ideal/scale + bias. */
 const float bias[3]={.02f,-.03f,.01f},scale[3]={1.02f,.98f,1.01f};
 sc_begin_accel(&c,now);CHECK(!sc_apply_accel(&c));CHECK(!sc_capture_face(&c,6,now));
 CHECK(sc_capture_face(&c,0,now));a[0]=-1;a[1]=a[2]=0;
 feed(&c,g,a,&now,600);CHECK(c.samples==0&&c.faces==0);sc_cancel(&c,"cancelled");
 sc_begin_accel(&c,now);
 for(unsigned f=0;f<6;f++){
  CHECK(sc_capture_face(&c,f,now));
  for(unsigned axis=0;axis<3;axis++)a[axis]=bias[axis]+(axis==f/2?((f&1)?-1.f:1.f)/scale[axis]:0.f);
  feed(&c,g,a,&now,501);CHECK(c.mode==SC_ACCEL_WAIT&&(c.faces&(1u<<f)));
 }
 CHECK(c.faces==63&&sc_apply_accel(&c)&&c.accel_valid);
 for(unsigned i=0;i<3;i++){CHECK(fabsf(c.accel_bias[i]-bias[i])<1e-5f);CHECK(fabsf(c.accel_scale[i]-scale[i])<1e-5f);}
 float corrected[3];sc_correct_accel(&c,a,corrected);CHECK(fabsf(corrected[2]+1)<1e-5f);
 sc_begin_accel(&c,now);sc_cancel(&c,"cancelled");CHECK(c.accel_valid&&fabsf(c.accel_scale[0]-scale[0])<1e-5f);
 sc_begin_accel(&c,now);sc_tick(&c,now+300000u);CHECK(c.mode==SC_ERROR&&c.accel_valid);
 /* A malicious/invalid staged solution never modifies applied coefficients. */
 sc_begin_accel(&c,now);c.faces=63;c.face_mean[0][0]=.01f;c.face_mean[1][0]=.01f;
 CHECK(!sc_apply_accel(&c));CHECK(fabsf(c.accel_scale[0]-scale[0])<1e-5f);
 puts("PASS: gyro and six-face solve, duplicates, motion/noise, wrong face, independent gyro at 0.82g, NaN, gaps, timeout, wrap, cancel and atomic apply");return 0;
}
