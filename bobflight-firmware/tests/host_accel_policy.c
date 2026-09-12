/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "drivers/sensor_calibration.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
#define CHECK(x) do{if(!(x)){fprintf(stderr,"FAIL policy line %d: %s\n",__LINE__,#x);return 1;}}while(0)
/* 0-based +X,-X,+Y,-Y,+Z,-Z. Recorded rounded telemetry, not physical validation. */
static const float latest[6][3]={
 {1.005026f,.049555f,-.183323f},{-.976254f,.038874f,-.062638f},
 {.000618f,1.041063f,-.175375f},{.017443f,-.954834f,-.137080f},
 {.011719f,.053319f,.817164f},{-.048927f,.026377f,-1.226277f}};
static const float earlier[6][3]={
 {.947144f,.046846f,.138541f},{-.861955f,.049229f,.287692f},
 {-.008671f,1.016616f,.023971f},{.026102f,-.900422f,.130023f},
 {.005488f,.050045f,.816500f},{-.241062f,.116950f,-1.193156f}};
static void ideal(sensor_calibration_t *c){
 sc_begin_accel(c,0);c->faces=63;
 for(unsigned f=0;f<6;f++)c->face_mean[f][f/2u]=(f&1u)?-1.f:1.f;
}
int main(void){
 sensor_calibration_t c;sc_init(&c);ideal(&c);CHECK(sc_apply_accel(&c));
 uint32_t now=0;sc_begin_accel(&c,now);const float gyro[3]={0,0,0};
 for(unsigned f=0;f<6;f++){
  CHECK(sc_capture_face(&c,f,now));
  for(unsigned i=0;i<501;i++)sc_feed(&c,gyro,latest[f],++now);
  CHECK(c.mode==SC_ACCEL_WAIT && (c.faces&(1u<<f)));
 }
 CHECK(c.faces==63);bool applied=sc_apply_accel(&c);
 CHECK(applied==(BOBFLIGHT_ACCEL_BENCH_RELAXED!=0));
 if(applied){
  CHECK(strstr(c.reason,"bench-relaxed-not-flight-qualified"));CHECK(strstr(c.apply_detail,"NOT flight-qualified"));
  CHECK(fabsf(c.accel_bias[2]+.2045565f)<1e-5f);
 }else CHECK(strstr(c.reason,"centers-disagree"));
 float saved_bias[3],saved_scale[3];memcpy(saved_bias,c.accel_bias,sizeof saved_bias);memcpy(saved_scale,c.accel_scale,sizeof saved_scale);
 ideal(&c);memcpy(c.face_mean,earlier,sizeof earlier);CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"coefficients"));
 ideal(&c);for(unsigned f=0;f<6;f++)c.face_mean[f][f/2u]*=.82f;
 CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"coefficients"));
 ideal(&c);for(unsigned f=0;f<6;f++){c.face_mean[f][0]+=.25f;c.face_mean[f][1]+=.25f;}
 CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"offset-too-large"));
 ideal(&c);c.face_mean[0][2]=c.face_mean[1][2]=SC_PAIR_CENTER_MAX_G+.001f;
 CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"centers-disagree"));
 ideal(&c);c.face_mean[0][2]=SC_POSE_RESIDUAL_MAX_G+.001f;c.face_mean[1][2]=-c.face_mean[0][2];
 CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"pose-residual"));
 ideal(&c);c.face_mean[0][2]=NAN;CHECK(!sc_apply_accel(&c));
 ideal(&c);c.faces=31;CHECK(!sc_apply_accel(&c));CHECK(strstr(c.reason,"six-faces"));
 CHECK(!memcmp(c.accel_bias,saved_bias,sizeof saved_bias)&&!memcmp(c.accel_scale,saved_scale,sizeof saved_scale));
 sc_cancel(&c,"cancelled");CHECK(c.accel_valid&&c.faces==0);
 CHECK(!memcmp(c.accel_bias,saved_bias,sizeof saved_bias));
 sc_init(&c);CHECK(!c.accel_valid&&c.accel_bias[2]==0&&c.accel_scale[2]==1);
 sc_begin_accel(&c,0);CHECK(sc_capture_face(&c,4,0));
 const float wrong[3]={0,0,-1},fall[3]={0,0,0},moving[3]={6,0,0},level[3]={0,0,1};
 for(unsigned i=0;i<510;i++){sc_feed(&c,gyro,wrong,++now);sc_feed(&c,gyro,fall,++now);sc_feed(&c,moving,level,++now);}
 CHECK(c.faces==0&&c.samples==0);
 sc_begin_accel(&c,now);CHECK(sc_capture_face(&c,4,now));
 for(unsigned i=0;i<501;i++){float noisy[3]={0,0,(i&1u)?1.04f:.96f};sc_feed(&c,gyro,noisy,++now);}
 CHECK(c.faces==0&&strstr(c.reason,"noisy"));
 printf("PASS %s: recorded latest captures, earlier bad captures, scale/bias/finite/missing-face limits, bounded pose relaxation, atomic rollback, reboot, motion/noise\n",BOBFLIGHT_ACCEL_BENCH_RELAXED?"relaxed bench":"strict default");return 0;
}
