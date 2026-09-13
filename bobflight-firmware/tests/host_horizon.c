/* SPDX-License-Identifier: Apache-2.0
 * Exact grid: roll/pitch stick indexes -100..100 inclusive divided by 100;
 * array axis indexes 0=roll,1=pitch,2=yaw. No physical flight qualification. */
#include "flight/horizon.h"
#include "flight/attitude.h"
#include "flight/rates.h"
#include "flight/config.h"
#include <math.h>
#include <stdio.h>
#define CHECK(c) do{if(!(c)){fprintf(stderr,"horizon FAIL %d: %s\n",__LINE__,#c);return 1;}}while(0)
int main(void){
 config_init();attitude_init();float g[3]={0,0,0},a[3]={0,0.5f,0.8660254f};CHECK(attitude_update(g,a,0.001f));
 float s[4]={0,0,0.5f,0.4f},out[3],angle[3],rate[3];
 CHECK(horizon_rate_weight(s)==0);s[0]=0.1f;CHECK(horizon_rate_weight(s)==0);
 s[0]=0.55f;CHECK(fabsf(horizon_rate_weight(s)-0.5f)<0.000001f);
 s[0]=1;CHECK(horizon_rate_weight(s)==1);
 for(int x=-100;x<=100;x++)for(int y=-100;y<=100;y++){
  s[0]=x/100.f;s[1]=y/100.f;horizon_setpoint(s,out);attitude_setpoint(s,angle);rates_update(s,rate);
  float d=fmaxf(fabsf(s[0]),fabsf(s[1])),w=d<=0.1f?0:d>=1?1:(d-0.1f)/0.9f;
  CHECK(isfinite(out[0])&&isfinite(out[1])&&isfinite(out[2]));
  for(unsigned i=0;i<2;i++)CHECK(fabsf(out[i]-((1-w)*angle[i]+w*rate[i]))<0.0003f);
  CHECK(out[2]==rate[2]);
  if(d<=0.1f){CHECK(out[0]==angle[0]);CHECK(out[1]==angle[1]);}
  if(d==1){CHECK(out[0]==rate[0]);CHECK(out[1]==rate[1]);}
 }
 s[0]=NAN;horizon_setpoint(s,out);CHECK(out[0]==0&&out[1]==0&&out[2]==0);
 horizon_setpoint(NULL,out);CHECK(out[0]==0&&out[1]==0&&out[2]==0);
 horizon_setpoint(s,NULL);
 puts("PASS Horizon 40401-point blend grid, center/full endpoints, shared-axis weight, yaw rate, invalid input");return 0;
}
