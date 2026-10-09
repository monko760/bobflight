/* SPDX-License-Identifier: Apache-2.0. Independent numerical reference vectors. */
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include "flight/config.h"
#include "flight/rates.h"
static void near(float a,float b){assert(isfinite(a)&&fabsf(a-b)<.002f);}
int main(void){
 const float x[5]={0,.25f,.5f,.75f,1};
 const float golden[3][5]={{0,79.375f,217.5f,414.375f,670},{0,64.744873046875f,162.421875f,324.012451171875f,670},{0,50.11474609375f,107.34375f,233.64990234375f,670}};
 for(unsigned e=0;e<3;e++)for(unsigned j=0;j<5;j++){near(rates_actual_map(x[j],200,670,e*.5f),golden[e][j]);near(rates_actual_map(-x[j],200,670,e*.5f),-golden[e][j]);}
 for(unsigned e=0;e<=100;e++){
  near(rates_actual_map(.000001f,200,670,e*.01f)/.000001f,200);
  near(rates_actual_map(1,200,670,e*.01f),670);near(rates_actual_map(.5f,400,200,e*.01f),200);
  float prev=0;for(unsigned j=0;j<=100;j++){float v=rates_actual_map(j*.01f,200,670,e*.01f);assert(v>=prev-.001f);prev=v;}
 }
 near(rates_actual_map(2,200,670,.5f),670);near(rates_actual_map(-2,200,670,.5f),-670);
 near(rates_actual_map(NAN,200,670,.5f),0);near(rates_actual_map(INFINITY,200,670,.5f),0);near(rates_actual_map(.5f,NAN,670,.5f),0);
 near(rates_actual_map(.5f,200,670,1.01f),0);near(rates_actual_map(.5f,-1,670,.5f),0);
 config_init();float ignored;assert(!config_get_key("rate_type",&ignored)&&!config_get_key("rate_expo",&ignored));assert(!config_set_key("rate_type",1));assert(!config_set_key("rate_center_roll",2001));assert(!config_set_key("rate_expo_yaw",NAN));
 assert(config_set_key("rate_max_roll",670));assert(config_set_key("rate_center_pitch",100));assert(config_set_key("rate_max_pitch",700));assert(config_set_key("rate_center_yaw",300));assert(config_set_key("rate_expo_roll",1));assert(config_set_key("rate_expo_pitch",0));assert(config_set_key("rate_expo_yaw",.5f));
 float rc[4]={.51f,.51f,-.51f,0},out[3];rates_update(rc,out);near(out[0],107.34375f);near(out[1],200);near(out[2],-216.40625f);
 rc[0]=.02f;rc[1]=-.02f;rc[2]=NAN;rates_update(rc,out);for(unsigned j=0;j<3;j++)near(out[j],0);
 rates_update(NULL,out);for(unsigned j=0;j<3;j++)near(out[j],0);rates_update(rc,NULL);
 config_init();rc[0]=.51f;rates_update(rc,out);near(out[0],rates_actual_map(.5f,200,800,.3f));
 puts("PASS Actual golden vectors, independent center/expo, oddness, endpoints, monotonicity, clamps, finite guards, per-axis routing, deadband once, Actual-only defaults and removed legacy keys");
}
