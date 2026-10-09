/* SPDX-License-Identifier: Apache-2.0 */
#include "flight/config.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
static void close3(const float *a,const float *b){for(unsigned i=0;i<3;i++)assert(fabsf(a[i]-b[i])<0.00002f);}
static float dot(const float*a,const float*b){return a[0]*b[0]+a[1]*b[1]+a[2]*b[2];}
int main(void){
 config_init();float v[3]={1,2,3};config_board_alignment_apply(v);close3(v,(float[]){1,2,3});
 assert(config_set_key("align_board_roll",180));assert(config_board_alignment_pending());
 config_board_alignment_apply(v);close3(v,(float[]){1,2,3}); /* staged only */
 config_board_alignment_activate();assert(!config_board_alignment_pending());
 config_board_alignment_apply(v);close3(v,(float[]){1,-2,-3});
 config_defaults();assert(config_board_alignment_pending()); /* defaults is not a live frame jump */
 v[0]=1;v[1]=2;v[2]=3;config_board_alignment_apply(v);close3(v,(float[]){1,-2,-3});
 config_board_alignment_activate();assert(!config_board_alignment_pending());
 const float angles[]={-180,-90,-15,0,15,90,180};unsigned cases=0;
 for(unsigned r=0;r<7;r++)for(unsigned p=0;p<7;p++)for(unsigned y=0;y<7;y++){
  assert(config_set_key("align_board_roll",angles[r]));assert(config_set_key("align_board_pitch",angles[p]));assert(config_set_key("align_board_yaw",angles[y]));
  config_board_alignment_activate();float x[3]={1,0,0},b[3]={0,1,0},z[3]={0,0,1};
  config_board_alignment_apply(x);config_board_alignment_apply(b);config_board_alignment_apply(z);
  assert(fabsf(dot(x,x)-1)<.00001f&&fabsf(dot(b,b)-1)<.00001f&&fabsf(dot(z,z)-1)<.00001f);
  assert(fabsf(dot(x,b))<.00001f&&fabsf(dot(x,z))<.00001f&&fabsf(dot(b,z))<.00001f);
  float cross[3]={x[1]*b[2]-x[2]*b[1],x[2]*b[0]-x[0]*b[2],x[0]*b[1]-x[1]*b[0]};close3(cross,z);cases++;
 }
 config_init();assert(config_set_key("align_board_roll",90));assert(config_set_key("align_board_yaw",90));config_board_alignment_activate();
 float order[3]={0,1,0};config_board_alignment_apply(order);close3(order,(float[]){0,0,1}); /* Rx then Rz, not reverse */
 for(unsigned i=0;i<6;i++){float invalid[]={NAN,INFINITY,-INFINITY,181,-181,.5f};assert(!config_set_key("align_board_roll",invalid[i]));}
 assert(!config_set_key("align_board_unknown",0));
 printf("PASS %u proper mounting rotations, composition, defaults/staging, bounds\n",cases);
}
