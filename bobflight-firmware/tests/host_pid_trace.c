/* SPDX-License-Identifier: Apache-2.0 */
#include "flight/pid.h"
#include "flight/config.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <string.h>
void baseline_pid_init(void);void baseline_pid_set_dt(float);
void baseline_pid_update(const float *,const float *,pid_axis_out_t *);
int main(void){
 config_init();pid_init();baseline_pid_init();pid_trace_t t;assert(!pid_trace_read(&t));assert(!pid_trace_read(0));
 float g[3]={0},s[3]={0};pid_axis_out_t a,b;
 for(unsigned n=0;n<30000;n++){
  bool on=n>=10000&&n<20000;if(n==10000||n==20000)pid_trace_enable(on);
  if(n%777==0){pid_init();baseline_pid_init();assert(!pid_trace_read(&t));}
  float dt=(float)(250+(n%7)*250)*.000001f;pid_set_dt(dt);baseline_pid_set_dt(dt);
  for(unsigned j=0;j<3;j++){g[j]=sinf((float)(n*(j+1))*.006f)*200.f;s[j]=cosf((float)(n*(j+1))*.003f)*400.f;}
  pid_update(g,s,&a);baseline_pid_update(g,s,&b);assert(memcmp(&a,&b,sizeof a)==0);assert(pid_trace_read(&t)==on);
  if(on){assert(t.dt==dt);float o[3]={a.roll,a.pitch,a.yaw};for(unsigned j=0;j<3;j++){assert(t.gyro[j]==g[j]&&t.setpoint[j]==s[j]);assert(t.error[j]==s[j]-g[j]);assert(fabsf(t.p[j]+t.i[j]+t.d[j]-t.sum[j])<1e-5f);assert(t.output[j]==o[j]);}}
 }
 pid_trace_enable(true);pid_update(g,s,&a);assert(pid_trace_read(&t));g[1]=NAN;pid_update(g,s,&a);assert(!pid_trace_read(&t));assert(a.roll==0&&a.pitch==0&&a.yaw==0);
 pid_trace_enable(false);assert(!pid_trace_read(&t));puts("PASS: 30000 bit-exact baseline comparisons; terms/reset/disable/null/nonfinite");
}
