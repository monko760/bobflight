/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "drivers/imu_orientation.h"
#include <math.h>
#include <stdio.h>
#define CHECK(x) do {if(!(x)){fprintf(stderr,"line %d\n",__LINE__);return 1;}} while(0)
int main(void) {
 const char *names[]={"CW0_DEG","CW90_DEG","CW180_DEG","CW270_DEG"};
 /* Independent basis-vector matrices: each row lists transformed X/Y/Z bases. */
 const float golden[4][3][3]={
  {{1,0,0},{0,1,0},{0,0,1}},
  {{0,-1,0},{1,0,0},{0,0,1}},
  {{-1,0,0},{0,-1,0},{0,0,1}},
  {{0,1,0},{-1,0,0},{0,0,1}}};
 for(unsigned r=0;r<4;r++) {
  imu_orientation_t o;CHECK(imu_orientation_parse(names[r],&o));
  for(unsigned basis=0;basis<3;basis++) {
   float v[3]={0,0,0};v[basis]=1;CHECK(imu_orientation_apply(o,v));
   for(unsigned axis=0;axis<3;axis++)CHECK(v[axis]==golden[r][basis][axis]);
  }
  float v[3]={2,-3,4};CHECK(imu_orientation_apply(o,v));
  CHECK(v[0]*v[0]+v[1]*v[1]+v[2]*v[2]==29);
  for(unsigned turn=0;turn<3;turn++)CHECK(imu_orientation_apply(o,v));
  CHECK(v[0]==2 && v[1]==-3 && v[2]==4);
 }
 const char *invalid[]={"","CW45_DEG","CW0_DEG_FLIP","CW270_DEG_FLIP","cw0_deg","CW0_DEG ","unknown"};
 for(unsigned i=0;i<sizeof(invalid)/sizeof(invalid[0]);i++) {
  imu_orientation_t o=IMU_CW270;CHECK(!imu_orientation_parse(invalid[i],&o));CHECK(o==IMU_CW270);
 }
 imu_orientation_t o=IMU_CW0;CHECK(!imu_orientation_parse(NULL,&o));CHECK(!imu_orientation_parse("CW0_DEG",NULL));
 float v[3]={1,2,3};CHECK(!imu_orientation_apply((imu_orientation_t)99,v));CHECK(v[0]==1&&v[1]==2&&v[2]==3);
 CHECK(!imu_orientation_apply(IMU_CW0,NULL));
 puts("PASS: 12 basis vectors, norm/cycle preservation and invalid-input rejection");return 0;
}
