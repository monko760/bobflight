/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Original encoder of the publicly readable Blackbox wire format, not copied
 * Betaflight firmware code. External Explorer is used only as a test oracle.
 * Gyro/raw gyro: signed decidegrees/s. Setpoint: rounded degrees/s.
 * P/I/D and clamped PID output: signed normalized command * 1000.
 * Motors: actual DShot throttle representation (0 stop, 48..2047 active).
 * RC: roll/pitch/yaw *500, throttle 1000+1000*normalized.
 * bobflightError: directly computed setpoint-gyro, in degrees/s. Select this
 * instead of Explorer's legacy-derived axisError for truthful BobFlight logs.
 */
#include "flight/blackbox_encode.h"
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>

#define FIELD_COUNT 42u
static const char *const names[FIELD_COUNT]={
 "loopIteration","time",
 "gyroADC[0]","gyroADC[1]","gyroADC[2]",
 "bobflightRawGyro[0]","bobflightRawGyro[1]","bobflightRawGyro[2]",
 "setpoint[0]","setpoint[1]","setpoint[2]","setpoint[3]",
 "axisP[0]","axisP[1]","axisP[2]",
 "axisI[0]","axisI[1]","axisI[2]",
 "axisD[0]","axisD[1]","axisD[2]",
 "bobflightOutput[0]","bobflightOutput[1]","bobflightOutput[2]",
 "motor[0]","motor[1]","motor[2]","motor[3]",
 "rcCommand[0]","rcCommand[1]","rcCommand[2]","rcCommand[3]",
 "bobflightError[0]","bobflightError[1]","bobflightError[2]",
 "bobflightArmed","bobflightMode","bobflightFailsafe",
 "bobflightDtUs","bobflightDropped","bobflightIteration","bobflightSchema"
};
/* Unsigned absolute 32-bit integers avoid overflow in sequence/counter fields. */
static bool unsigned_field(unsigned i){return i<2u || i>=35u;}
static size_t add(char *b,size_t n,size_t cap,const char *s){
 size_t k=strlen(s);if(n>=cap||k>=cap-n)return cap;memcpy(b+n,s,k);b[n+k]=0;return n+k;
}
size_t blackbox_header(char *dst,size_t cap,const blackbox_metadata_t *m){
 if(!dst||!m||!m->revision||!m->config)return 0;
 uint32_t hz=m->sample_hz;const char *revision=m->revision;
 if((hz!=250u&&hz!=500u&&hz!=1000u)||m->loop_hz<hz||m->loop_hz>8000u||m->loop_hz%hz||(m->dshot_kbps!=300&&m->dshot_kbps!=600))return 0;
 size_t len=0;while(revision[len]){if(len>=96u||!((revision[len]>='a'&&revision[len]<='z')||(revision[len]>='A'&&revision[len]<='Z')||(revision[len]>='0'&&revision[len]<='9')||revision[len]=='.'||revision[len]=='-'||revision[len]=='_'))return 0;len++;}
 if(!len)return 0;
 char b[4096],t[160];size_t n=0;
 /* Exact signature required by Explorer's file indexer; it identifies the
  * Blackbox format, not authorship of this independent implementation. */
 n=add(b,n,sizeof b,"H Product:Blackbox flight data recorder by Nicholas Sherlock\nH Data version:2\nH Firmware type:BobFlight\nH Firmware revision:BobFlight ");
 n=add(b,n,sizeof b,revision);n=add(b,n,sizeof b,"\n");
 snprintf(t,sizeof t,"H I interval:%lu\nH P interval:1/%lu\n",(unsigned long)(m->loop_hz/hz),(unsigned long)(m->loop_hz/hz));n=add(b,n,sizeof b,t);
 snprintf(t,sizeof t,"H looptime:%lu\n",(unsigned long)(1000000u/m->loop_hz));n=add(b,n,sizeof b,t);
 /* IEEE754 bits for 0.1 degree/s in the legacy radians/microsecond scale.
  * Explorer treats an honestly identified BobFlight file as legacy firmware. */
 n=add(b,n,sizeof b,"H gyro.scale:30efe050\nH minthrottle:1000\nH maxthrottle:2000\nH motorOutput:48,2047\n");
 snprintf(t,sizeof t,"H motor_pwm_protocol:%u\n",m->dshot_kbps==300?6:7);n=add(b,n,sizeof b,t);
 const bf_config_t *c=m->config;
 const float values[]={c->rate_max_roll,c->rate_max_pitch,c->rate_max_yaw,c->rate_expo,c->pid_roll_p,c->pid_roll_i,c->pid_roll_d,c->pid_pitch_p,c->pid_pitch_i,c->pid_pitch_d,c->pid_yaw_p,c->pid_yaw_i};
 const char *keys[]={"rate_max_roll","rate_max_pitch","rate_max_yaw","rate_expo","pid_roll_p","pid_roll_i","pid_roll_d","pid_pitch_p","pid_pitch_i","pid_pitch_d","pid_yaw_p","pid_yaw_i"};
 for(unsigned k=0;k<12;k++){if(!isfinite(values[k]))return 0;snprintf(t,sizeof t,"H BobFlight %s:%.9g\n",keys[k],(double)values[k]);n=add(b,n,sizeof b,t);}
 n=add(b,n,sizeof b,"H BobFlight units:gyro=0.1dps;setpoint,error=1dps;PID=0.001command;motor=DShot;dt=us\nH BobFlight warning:plot setpoint[] and bobflightError[]; legacy computed rate/error fields are not BobFlight\nH Field I name:");
 for(unsigned i=0;i<FIELD_COUNT;i++){if(i)n=add(b,n,sizeof b,",");n=add(b,n,sizeof b,names[i]);}
 n=add(b,n,sizeof b,"\nH Field I signed:");
 for(unsigned i=0;i<FIELD_COUNT;i++){if(i)n=add(b,n,sizeof b,",");n=add(b,n,sizeof b,unsigned_field(i)?"0":"1");}
 const char *lines[]={"\nH Field I predictor:","\nH Field I encoding:","\nH Field P predictor:","\nH Field P encoding:"};
 for(unsigned l=0;l<4;l++){n=add(b,n,sizeof b,lines[l]);for(unsigned i=0;i<FIELD_COUNT;i++){if(i)n=add(b,n,sizeof b,",");n=add(b,n,sizeof b,(l%2u)&&unsigned_field(i)?"1":"0");}}
 n=add(b,n,sizeof b,"\n");if(n>=sizeof b||n>=cap)return 0;memcpy(dst,b,n+1u);return n;
}
static bool quant(float value,double scale,int32_t *out){
 if(!isfinite(value))return false;double v=(double)value*scale;
 double q=v<0?ceil(v-0.5):floor(v+0.5);if(q<(double)INT32_MIN||q>(double)INT32_MAX)return false;*out=(int32_t)q;return true;
}
static size_t uv(uint8_t *dst,uint32_t v){size_t n=0;while(v>=128u){dst[n++]=(uint8_t)((v&127u)|128u);v>>=7;}dst[n++]=(uint8_t)v;return n;}
size_t blackbox_frame(uint8_t *dst,size_t cap,const flight_log_sample_t *s){
 if(!dst||!s)return 0;int32_t v[FIELD_COUNT]={0};uint32_t u[FIELD_COUNT]={0};
 u[0]=s->iteration;u[1]=s->time_us;
 for(unsigned a=0;a<3;a++){
  if(!quant(s->gyro[a],10,&v[2+a])||!quant(s->gyro_raw[a],10,&v[5+a])||!quant(s->setpoint[a],1,&v[8+a])||!quant(s->p[a],1000,&v[12+a])||!quant(s->i[a],1000,&v[15+a])||!quant(s->d[a],1000,&v[18+a])||!quant(s->pid_output[a],1000,&v[21+a])||!quant(s->setpoint[a]-s->gyro[a],1,&v[32+a]))return 0;
  if(!isfinite(s->rc[a])||s->rc[a]<-1||s->rc[a]>1||!quant(s->rc[a],500,&v[28+a]))return 0;
 }
 for(unsigned a=0;a<4;a++){
  float m=s->motor[a];if(!isfinite(m)||m<0||m>1)return 0;
  /* Same quantization as production dshot.c; zero is a real stop command. */
  v[24+a]=m<=0?0:(int32_t)(48u+(unsigned)(m*1999.f));
 }
 if(!isfinite(s->rc[3])||s->rc[3]<0||s->rc[3]>1||!quant(s->rc[3],1000,&v[11]))return 0;
 v[31]=1000+v[11];u[35]=s->armed;u[36]=s->mode;u[37]=s->failsafe;u[38]=s->dt_us;u[39]=s->dropped;u[40]=s->iteration;u[41]=1;
 uint8_t b[1+FIELD_COUNT*5];size_t n=0;b[n++]='I';
 for(unsigned i=0;i<FIELD_COUNT;i++){
  uint32_t bits=unsigned_field(i)?u[i]:((uint32_t)v[i]<<1)^(v[i]<0?UINT32_MAX:0u);
  n+=uv(b+n,bits);
 }
 if(cap<n)return 0;memcpy(dst,b,n);return n;
}
size_t blackbox_end(uint8_t *dst,size_t cap){
 static const uint8_t end[]={'E',255,'E','n','d',' ','o','f',' ','l','o','g',0};
 if(!dst||cap<sizeof end)return 0;memcpy(dst,end,sizeof end);return sizeof end;
}
