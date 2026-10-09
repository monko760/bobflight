/* SPDX-License-Identifier: Apache-2.0 */
#include "flight/attitude.h"
#include <math.h>
#include <stdio.h>
#define CHECK(x) do{if(!(x)){fprintf(stderr,"yaw test line %d: %s\n",__LINE__,#x);return 1;}}while(0)
#define NEAR(a,b) CHECK(fabsf((a)-(b))<.03f)
int main(void){
 const float rad=.01745329252f;
 float acc[3]={0,0,1},gyro[3]={0,0,90};
 attitude_init();NEAR(attitude_degrees()[2],0);
 /* Same integrated angle at each supported loop cadence. */
 const unsigned hz[]={1000,4000,8000};
 for(unsigned rate=0;rate<3;rate++){
  attitude_init();
  for(unsigned i=0;i<hz[rate];i++)CHECK(attitude_update(gyro,acc,1.f/hz[rate]));
  NEAR(attitude_degrees()[2],90);NEAR(attitude_degrees()[0],0);NEAR(attitude_degrees()[1],0);
 }
 gyro[2]=-90;attitude_init();for(unsigned i=0;i<1000;i++)CHECK(attitude_update(gyro,acc,.001f));NEAR(attitude_degrees()[2],-90);
 /* Both wrap directions, repeated turns, and a high but realistic gyro rate. */
 gyro[2]=2000;attitude_init();for(unsigned i=0;i<1000;i++){CHECK(attitude_update(gyro,acc,.001f));CHECK(fabsf(attitude_degrees()[2])<=180);}
 NEAR(attitude_degrees()[2],-160);
 gyro[2]=-2000;attitude_init();for(unsigned i=0;i<1000;i++){CHECK(attitude_update(gyro,acc,.001f));CHECK(fabsf(attitude_degrees()[2])<=180);}
 NEAR(attitude_degrees()[2],160);
 /* Rotation about world down with bank + pitch: do not merely integrate gyro Z. */
 const float roll=30*rad,pitch=20*rad,rate=45;
 acc[0]=-sinf(pitch);acc[1]=sinf(roll)*cosf(pitch);acc[2]=cosf(roll)*cosf(pitch);
 gyro[0]=-rate*sinf(pitch);gyro[1]=rate*sinf(roll)*cosf(pitch);gyro[2]=rate*cosf(roll)*cosf(pitch);
 attitude_init();for(unsigned i=0;i<1000;i++)CHECK(attitude_update(gyro,acc,.001f));
 NEAR(attitude_degrees()[0],30);NEAR(attitude_degrees()[1],20);NEAR(attitude_degrees()[2],45);
 /* Yaw does not leak into the existing outer-loop yaw rate setpoint. */
 float sticks[4]={0,0,.5f,0},out[3];attitude_setpoint(sticks,out);NEAR(out[2],100);
 sticks[2]=0;attitude_setpoint(sticks,out);NEAR(out[2],0);
 /* Bad timing, nonfinite input and existing singularity gate do not invent yaw. */
 const float before=attitude_degrees()[2];
 CHECK(!attitude_update(gyro,acc,.1f));NEAR(attitude_degrees()[2],before);
 CHECK(!attitude_update(gyro,acc,0));NEAR(attitude_degrees()[2],before);
 gyro[2]=NAN;CHECK(!attitude_update(gyro,acc,.001f));NEAR(attitude_degrees()[2],before);
 gyro[2]=INFINITY;CHECK(!attitude_update(gyro,acc,.001f));NEAR(attitude_degrees()[2],before);
 gyro[0]=gyro[1]=gyro[2]=0;acc[0]=-1;acc[1]=acc[2]=0;
 CHECK(!attitude_update(gyro,acc,.001f));CHECK(!attitude_ready());NEAR(attitude_degrees()[2],before);
 /* Reboot resets the relative reference; invalid acceleration cannot seed it. */
 attitude_init();NEAR(attitude_degrees()[2],0);acc[0]=0;
 CHECK(!attitude_update(gyro,acc,.001f));NEAR(attitude_degrees()[2],0);
 puts("PASS gyro-relative yaw: 1/4/8kHz, both signs/wraps, banked transform, invalid samples, reboot, unchanged yaw control");return 0;
}
