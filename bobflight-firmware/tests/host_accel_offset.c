/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "drivers/sensor_calibration.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#define CHECK(x) do{if(!(x)){fprintf(stderr,"FAIL accel offset line %d: %s\n",__LINE__,#x);return 1;}}while(0)
static void feed(sensor_calibration_t *c,uint32_t *now,const float a[3],unsigned n){
 const float g[3]={.1f,-.2f,.3f};
 for(unsigned i=0;i<n;i++)sc_feed(c,g,a,++*now);
}
/* Build all six stationary raw windows, not just hand-filled solver inputs.
 * Each component is ideal / scale + bias in post-board-rotation axes. */
static int stage(sensor_calibration_t *c,uint32_t *now,const float bias[3],const float scale[3]){
 sc_begin_accel(c,*now);
 for(unsigned f=0;f<6;f++){
  CHECK(sc_capture_face(c,f,*now));float a[3];
  for(unsigned axis=0;axis<3;axis++)a[axis]=bias[axis]+(axis==f/2u?((f&1u)?-1.f:1.f)/scale[axis]:0.f);
  feed(c,now,a,501);CHECK(c->mode==SC_ACCEL_WAIT);CHECK(c->faces&(1u<<f));
 }
 return 0;
}
int main(void){
 sensor_calibration_t c;sc_init(&c);uint32_t now=0;
 const float one[3]={1,1,1},zero[3]={0,0,0},bias[3]={0,0,-.2f};
 CHECK(stage(&c,&now,bias,one)==0);CHECK(c.faces==63&&!c.accel_valid);
 CHECK(fabsf(c.face_mean[4][2]-.8f)<1e-5f&&fabsf(c.face_mean[5][2]+1.2f)<1e-5f);
 CHECK(sc_apply_accel(&c));CHECK(strstr(c.reason,"large-offset"));
 CHECK(fabsf(c.accel_bias[2]+.2f)<1e-5f&&fabsf(c.accel_scale[2]-1)<1e-5f);
 float a[3]={0,0,.8f},corrected[3];sc_correct_accel(&c,a,corrected);CHECK(fabsf(corrected[2]-1)<1e-5f);
 sc_begin_gyro(&c,now);feed(&c,&now,a,1001);CHECK(c.mode==SC_COMPLETE&&c.gyro_valid);
 sc_begin_gyro(&c,now);a[2]=.4f;feed(&c,&now,a,1100);CHECK(c.samples==0&&strstr(c.reason,"gyro-raw-accel-outside"));
 /* All-axis offsets must survive orthogonal raw components, but are bounded
  * as a vector rather than allowing 0.3 g independently on every axis. */
 const float multi[3]={.18f,-.16f,.13f},scale[3]={1.02f,.98f,1.01f};
 CHECK(stage(&c,&now,multi,scale)==0);CHECK(sc_apply_accel(&c));
 for(unsigned i=0;i<3;i++){CHECK(fabsf(c.accel_bias[i]-multi[i])<1e-5f);CHECK(fabsf(c.accel_scale[i]-scale[i])<1e-5f);}
 float old_bias[3],old_scale[3];memcpy(old_bias,c.accel_bias,sizeof old_bias);memcpy(old_scale,c.accel_scale,sizeof old_scale);
 /* Uniform low sensitivity is NOT repaired by per-sample normalization. */
 const float bad_scale[3]={1.f/.82f,1.f/.82f,1.f/.82f};
 CHECK(stage(&c,&now,zero,bad_scale)==0);CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"coefficients"));
 const float stacked[3]={.25f,.25f,0};
 CHECK(stage(&c,&now,stacked,one)==0);CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"offset-too-large"));
 const float excessive[3]={0,0,-.31f};CHECK(stage(&c,&now,excessive,one)==0);CHECK(!sc_apply_accel(&c));
 /* Capturing a tilted but stationary pose must not become a good calibration. */
 CHECK(stage(&c,&now,zero,one)==0);c.face_mean[0][1]=.2f;
 CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"centers-disagree"));
 CHECK(c.candidate_valid&&strstr(c.apply_detail,"Pair +X/-X, axis Y")&&strstr(c.apply_detail,"difference=+0.10000 g"));
 CHECK(strstr(c.apply_detail,"limit=0.05000 g")&&c.apply_detail[sizeof(c.apply_detail)-1]==0);
 CHECK(stage(&c,&now,zero,one)==0);c.face_mean[0][1]=.15f;c.face_mean[1][1]=-.15f;
 CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"pose-residual"));
 CHECK(stage(&c,&now,zero,one)==0);c.face_mean[0][2]=NAN;CHECK(!sc_apply_accel(&c));
 CHECK(c.accel_valid&&memcmp(old_bias,c.accel_bias,sizeof old_bias)==0&&memcmp(old_scale,c.accel_scale,sizeof old_scale)==0);
 /* Staging still rejects wrong sign, freefall, excessive magnitude and motion. */
 sc_begin_accel(&c,now);CHECK(sc_capture_face(&c,4,now));
 const float bad[][3]={{0,0,-1},{0,0,0},{0,0,2},{.6f,0,.8f}};
 for(unsigned i=0;i<sizeof bad/sizeof bad[0];i++){feed(&c,&now,bad[i],510);CHECK(c.samples==0&&c.faces==0);}
 const float moving[3]={6,0,0};a[0]=a[1]=0;a[2]=.8f;sc_feed(&c,moving,a,++now);CHECK(c.samples==0);
 for(unsigned i=0;i<501;i++){a[2]=(i&1u)?.83f:.77f;feed(&c,&now,a,1);}
 CHECK(c.faces==0&&c.samples==0&&strstr(c.reason,"noisy"));
 const float still[3]={0,0,0};a[2]=.8f;
 for(unsigned i=0;i<1000;i++){sc_feed(&c,still,a,now);}CHECK(c.samples<=1&&c.faces==0);
 sc_cancel(&c,"cancelled");CHECK(!c.candidate_valid&&c.apply_detail[0]==0);CHECK(c.accel_valid&&memcmp(old_bias,c.accel_bias,sizeof old_bias)==0);
 puts("PASS: +/- offset faces, all-axis solve, gyro raw plausibility, large-offset warning, low sensitivity/oversized offset/pose inconsistency rejection, raw motion/noise/duplicates, atomic rollback");return 0;
}
