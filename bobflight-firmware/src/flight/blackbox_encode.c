/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Original encoder of the publicly readable Blackbox wire format, not copied
 * Betaflight firmware code. External Explorer is used only as a test oracle.
 * Gyro/raw gyro: signed decidegrees/s. Setpoint: rounded degrees/s.
 * P/I/D and clamped PID output: signed normalized command * 1000.
 * Motors: actual DShot throttle representation (0 stop, 48..2047 active).
 * RC: roll/pitch/yaw *500, throttle 1000+1000*normalized.
 * bfError: directly computed setpoint-gyro, in degrees/s. Select this
 * instead of Explorer's legacy-derived axisError for truthful BobFlight logs.
 */
#include "flight/blackbox_encode.h"
#include <math.h>
#include <stdbool.h>
#include <stdio.h>
#include <string.h>
#include <limits.h>

#define FIELD_COUNT BLACKBOX_FIELD_COUNT
static const char *const names[FIELD_COUNT]={
 "loopIteration","time",
 "gyroADC[0]","gyroADC[1]","gyroADC[2]",
 "gyroUnfilt[0]","gyroUnfilt[1]","gyroUnfilt[2]",
 "setpoint[0]","setpoint[1]","setpoint[2]","setpoint[3]",
 "axisP[0]","axisP[1]","axisP[2]",
 "axisI[0]","axisI[1]","axisI[2]",
 "axisD[0]","axisD[1]","axisD[2]",
 "bfOutput[0]","bfOutput[1]","bfOutput[2]",
 "motor[0]","motor[1]","motor[2]","motor[3]",
 "rcCommand[0]","rcCommand[1]","rcCommand[2]","rcCommand[3]",
 "bfError[0]","bfError[1]","bfError[2]",
 "bfArmed","bfMode","bfFailsafe",
 "bfDtUs","bfDropped","bfSchema",
 "bfPidValid","bfGyroValid","bfRxFresh","bfOutputHealthy",
 "accSmooth[0]","accSmooth[1]","accSmooth[2]",
 "imuQuaternion[0]","imuQuaternion[1]","imuQuaternion[2]",
 "bfAccelValid","bfAttitudeValid",
 "rssi","bfRssiDbm[0]","bfRssiDbm[1]","bfLinkQuality","bfLinkSnr","bfRxAntenna","bfRfMode","bfLinkAgeMs","bfLinkValid",
#if BLACKBOX_HAS_BAROMETER
 "baroAlt","bfBaroTempCentiC","bfPressurePa","bfBaroReferencePa","bfBaroAgeMs","bfBaroValid","bfBaroAltValid","bfBaroSample",
#endif
 "eRPM[0]","eRPM[1]","eRPM[2]","eRPM[3]",
 "bfTelemOk","bfFilterFlags","bfEvents","bfLoopCode","bfOverruns"
};
_Static_assert(sizeof names/sizeof names[0]==FIELD_COUNT,"field table must match BLACKBOX_FIELD_COUNT");
/* Unsigned absolute 32-bit integers avoid overflow in sequence/counter fields. */
static bool unsigned_field(unsigned i){return i<2u || (i>=35u&&i<45u) || (i>=51u&&i!=54u&&i!=55u&&i!=57u&&(!BLACKBOX_HAS_BAROMETER||(i!=62u&&i!=63u)));}
static size_t add(char *b,size_t n,size_t cap,const char *s){ size_t k=strlen(s);if(n>=cap||k>=cap-n)return cap;memcpy(b+n,s,k);b[n+k]=0;return n+k; }
size_t blackbox_header(char *dst,size_t cap,const blackbox_metadata_t *m){
 if(!dst||!m||!m->revision||!m->config)return 0; uint32_t hz=m->sample_hz;const char *revision=m->revision;
 if((hz!=125u&&hz!=250u&&hz!=500u&&hz!=1000u)||m->loop_hz<hz||m->loop_hz>8000u||m->loop_hz%hz||(m->dshot_kbps!=300&&m->dshot_kbps!=600))return 0;
 size_t len=0;while(revision[len]){if(len>=96u||!((revision[len]>='a'&&revision[len]<='z')||(revision[len]>='A'&&revision[len]<='Z')||(revision[len]>='0'&&revision[len]<='9')||revision[len]=='.'||revision[len]=='-'||revision[len]=='_'))return 0;len++;}
 if(!len)return 0;
 /* Board id is informational: never block a log over it. Sanitised to
  * [A-Za-z0-9._-] (others -> '_'), at most BLACKBOX_BOARD_MAX chars, "unknown" if empty. */
 char board[BLACKBOX_BOARD_MAX+1u];size_t board_len=0;
 for(const char *p=m->board;p&&*p&&board_len<BLACKBOX_BOARD_MAX;p++){char c=*p;
  board[board_len++]=((c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='.'||c=='-'||c=='_')?c:'_';}
 board[board_len]=0;if(!board_len)memcpy(board,"unknown",8);
 char b[BLACKBOX_HEADER_MAX_BYTES],t[160];size_t n=0;
 n=add(b,n,sizeof b,"H Product:Blackbox flight data recorder by Nicholas Sherlock\nH Data version:2\nH Firmware type:BobFlight\nH Firmware revision:BobFlight "); n=add(b,n,sizeof b,revision);n=add(b,n,sizeof b,"\n");
 {
  /* Fixed-width rate block: the BobFlight line is space-padded so the block is
   * always BLACKBOX_RATE_BLOCK_BYTES long (in-place effective-rate patch). */
  uint32_t requested=m->requested_hz?m->requested_hz:hz;const char *reason=m->rate_reason?m->rate_reason:"default";
  if(requested>1000u||requested<hz||strlen(reason)>24u)return 0;
  for(const char *r=reason;*r;r++)if(!((*r>='a'&&*r<='z')||*r=='-'))return 0;
  int k=snprintf(t,sizeof t,"H I interval:%lu\nH P interval:1/%lu\nH BobFlight log_rate_hz:%lu requested_hz:%lu reason:%s",
   (unsigned long)(m->loop_hz/hz),(unsigned long)(m->loop_hz/hz),(unsigned long)hz,(unsigned long)requested,reason);
  if(k<0||(size_t)k>=BLACKBOX_RATE_BLOCK_BYTES)return 0;
  while((size_t)k<BLACKBOX_RATE_BLOCK_BYTES-1u)t[k++]=' ';
  t[k++]='\n';t[k]=0;n=add(b,n,sizeof b,t);
 }
 snprintf(t,sizeof t,"H looptime:%lu\n",(unsigned long)(1000000u/m->loop_hz));n=add(b,n,sizeof b,t);
 n=add(b,n,sizeof b,"H gyro.scale:30efe050\nH acc_1G:4096\nH minthrottle:1000\nH maxthrottle:2000\nH motorOutput:48,2047\n"); snprintf(t,sizeof t,"H motor_pwm_protocol:%u\n",m->dshot_kbps==300?6:7);n=add(b,n,sizeof b,t);
 const bf_config_t *c=m->config;
 /* Standard `H motor_poles:` (as Betaflight writes it): stock Explorer turns eRPM[] into RPM with
  * value*200/motor_poles and assumes 1 pole without it (14x too high). Same frozen value as
  * `H BobFlight motor_poles`; written only for a valid pole count (config rule), never blocks a log. */
 if(config_rpm_value_valid("motor_poles",c->motor_poles)){snprintf(t,sizeof t,"H motor_poles:%u\n",(unsigned)c->motor_poles);n=add(b,n,sizeof b,t);}
 const float values[]={c->rate_max_roll,c->rate_max_pitch,c->rate_max_yaw,c->pid_roll_p,c->pid_roll_i,c->pid_roll_d,c->pid_pitch_p,c->pid_pitch_i,c->pid_pitch_d,c->pid_yaw_p,c->pid_yaw_i,c->pid_yaw_d}; const char *keys[]={"rate_max_roll","rate_max_pitch","rate_max_yaw","pid_roll_p","pid_roll_i","pid_roll_d","pid_pitch_p","pid_pitch_i","pid_pitch_d","pid_yaw_p","pid_yaw_i","pid_yaw_d"};
 for(unsigned k=0;k<sizeof values/sizeof values[0];k++){if(!isfinite(values[k]))return 0;snprintf(t,sizeof t,"H BobFlight %s:%.9g\n",keys[k],(double)values[k]);n=add(b,n,sizeof b,t);}
 /* Exact Actual-profile metadata; identity remains BobFlight, never spoof Betaflight. */
 {const float rv[]={c->rate_center_roll,c->rate_center_pitch,c->rate_center_yaw,c->rate_expo_roll,c->rate_expo_pitch,c->rate_expo_yaw};
  const char *rk[]={"rate_center_roll","rate_center_pitch","rate_center_yaw","rate_expo_roll","rate_expo_pitch","rate_expo_yaw"};
  for(unsigned k=0;k<sizeof rv/sizeof rv[0];k++){if(!isfinite(rv[k]))return 0;snprintf(t,sizeof t,"H BobFlight %s:%.9g\n",rk[k],(double)rv[k]);n=add(b,n,sizeof b,t);}
  n=add(b,n,sizeof b,"H BobFlight rate_model:Actual\nH BobFlight rate_input:rcCommand=pre-deadband;deadband=0.02-rescaled-once\n");
 }
 /* Schema 3 context. Configuration is frozen while recording (blackbox_cli.h),
  * so these stay true for the whole file; a loop-rate change mid-session is
  * carried per frame by bfLoopCode and bfEvents bit 5. */
 snprintf(t,sizeof t,"H BobFlight log_schema:%u\nH BobFlight board:",BLACKBOX_LOG_SCHEMA);n=add(b,n,sizeof b,t);n=add(b,n,sizeof b,board);
 n=add(b,n,sizeof b,"\nH BobFlight fw_version:");n=add(b,n,sizeof b,revision);
 snprintf(t,sizeof t,"\nH BobFlight loop_rate_hz:%lu gyro_hz:%lu pid_denom:%lu\n",(unsigned long)m->loop_hz,(unsigned long)m->gyro_hz,(unsigned long)m->pid_denom);n=add(b,n,sizeof b,t);
 {const float fv[]={c->gyro_lpf_hz,c->gyro_notch1_hz,c->gyro_notch1_cutoff_hz,c->gyro_notch2_hz,c->gyro_notch2_cutoff_hz,c->rpm_filter_harmonics,c->rpm_filter_min_hz,c->rpm_filter_q_x100,c->motor_poles};
  const char *fk[]={"gyro_lpf_hz","gyro_notch1_hz","gyro_notch1_cutoff_hz","gyro_notch2_hz","gyro_notch2_cutoff_hz","rpm_filter_harmonics","rpm_filter_min_hz","rpm_filter_q_x100","motor_poles"};
  for(unsigned k=0;k<sizeof fv/sizeof fv[0];k++){if(!isfinite(fv[k]))return 0;snprintf(t,sizeof t,"H BobFlight %s:%.6g\n",fk[k],(double)fv[k]);n=add(b,n,sizeof b,t);}}
 n=add(b,n,sizeof b,"H BobFlight units:gyro=0.1dps;setpoint,error=1dps;PID=0.001command;motor=DShot;dt=us;eRPM=eRPM/100;events,flags=bits(docs/BLACKBOX-FIELDS.md)\nH BobFlight warning:plot setpoint[] and bfError[]; legacy computed rate/error fields are not BobFlight\nH Field I name:");
 for(unsigned i=0;i<FIELD_COUNT;i++){if(i)n=add(b,n,sizeof b,",");n=add(b,n,sizeof b,names[i]);} n=add(b,n,sizeof b,"\nH Field I signed:");
 for(unsigned i=0;i<FIELD_COUNT;i++){if(i)n=add(b,n,sizeof b,",");n=add(b,n,sizeof b,unsigned_field(i)?"0":"1");}
 const char *lines[]={"\nH Field I predictor:","\nH Field I encoding:","\nH Field P predictor:","\nH Field P encoding:"};
 for(unsigned l=0;l<4;l++){n=add(b,n,sizeof b,lines[l]);for(unsigned i=0;i<FIELD_COUNT;i++){if(i)n=add(b,n,sizeof b,",");n=add(b,n,sizeof b,(l%2u)&&unsigned_field(i)?"1":"0");}}
 n=add(b,n,sizeof b,"\n");if(n>=sizeof b||n>=cap)return 0;
 size_t line_len=0;for(size_t j=0;j<n;j++){if(b[j]=='\n')line_len=0;else if(++line_len>1023u)return 0;}
 memcpy(dst,b,n+1u);return n;
}
static bool quant(float value,double scale,int32_t *out){if(!isfinite(value))return false;double v=(double)value*scale;double q=v<0?ceil(v-0.5):floor(v+0.5);if(q<(double)INT32_MIN||q>(double)INT32_MAX)return false;*out=(int32_t)q;return true;}
static size_t uv(uint8_t *dst,uint32_t v){size_t n=0;while(v>=128u){dst[n++]=(uint8_t)((v&127u)|128u);v>>=7;}dst[n++]=(uint8_t)v;return n;}
size_t blackbox_frame(uint8_t *dst,size_t cap,const flight_log_sample_t *s){
 if(!dst||!s||!flight_log_sample_flags_valid(s))return 0;
 int32_t v[FIELD_COUNT]={0};uint32_t u[FIELD_COUNT]={0};u[0]=s->iteration;u[1]=s->time_us;
 for(unsigned a=0;a<3;a++){if(!quant(s->gyro[a],10,&v[2+a])||!quant(s->gyro_raw[a],10,&v[5+a])||!quant(s->setpoint[a],1,&v[8+a])||!quant(s->p[a],1000,&v[12+a])||!quant(s->i[a],1000,&v[15+a])||!quant(s->d[a],1000,&v[18+a])||!quant(s->pid_output[a],1000,&v[21+a])||!quant(s->setpoint[a]-s->gyro[a],1,&v[32+a]))return 0;if(!isfinite(s->rc[a])||s->rc[a]<-1||s->rc[a]>1||!quant(s->rc[a],500,&v[28+a]))return 0;}
 for(unsigned a=0;a<4;a++){float m=s->motor[a];if(!isfinite(m)||m<0||m>1)return 0;v[24+a]=m<=0?0:(int32_t)(48u+(unsigned)(m*1999.f));}
 if(!isfinite(s->rc[3])||s->rc[3]<0||s->rc[3]>1||!quant(s->rc[3],1000,&v[31]))return 0;
 if(!isfinite(s->setpoint_throttle)||s->setpoint_throttle<0||s->setpoint_throttle>1||!quant(s->setpoint_throttle,1000,&v[11]))return 0;
 v[31]+=1000;u[35]=s->armed;u[36]=s->mode;u[37]=s->failsafe;u[38]=s->dt_us;u[39]=s->dropped;u[40]=BLACKBOX_LOG_SCHEMA;u[41]=s->pid_valid;u[42]=s->gyro_valid;u[43]=s->rx_fresh;u[44]=s->output_healthy;
 /* All trigonometry runs in the background encoder, never the capture hook.
  * Explorer quaternion convention has heading = negative quaternion yaw.
  * Convert the actual estimator Euler values, not a second estimated attitude.
  * Quaternion xyz are signed Q15; choose the hemisphere with nonnegative w. */
 if(s->accel_valid)for(unsigned a=0;a<3;a++)if(!quant(s->accel_g[a],4096,&v[45+a]))return 0;
 if(s->attitude_valid){
  for(unsigned a=0;a<3;a++)if(!isfinite(s->attitude_deg[a])||fabsf(s->attitude_deg[a])>360.f)return 0;
  const float half_rad=0.00872664626f;
  float r=s->attitude_deg[0]*half_rad,p=s->attitude_deg[1]*half_rad,y=-s->attitude_deg[2]*half_rad;
  float sr=sinf(r),cr=cosf(r),sp=sinf(p),cp=cosf(p),sy=sinf(y),cy=cosf(y);
  float w=cr*cp*cy+sr*sp*sy, sign=w<0?-1.f:1.f;
  float q[3]={(float)(sign*(sr*cp*cy-cr*sp*sy)),(float)(sign*(cr*sp*cy+sr*cp*sy)),(float)(sign*(cr*cp*sy-sr*sp*cy))};
  for(unsigned a=0;a<3;a++)if(!quant(q[a],32767,&v[48+a]))return 0;
 }
 u[51]=s->accel_valid;u[52]=s->attitude_valid;
 if(s->link_valid){
  int dbm=s->rssi_dbm[s->link_antenna];if(dbm< -130)dbm=-130;if(dbm>0)dbm=0;
  u[53]=(uint32_t)((dbm+130)*1023/130); /* BF CRSF range, not link quality */
  v[54]=s->rssi_dbm[0];v[55]=s->rssi_dbm[1];u[56]=s->link_lq;v[57]=s->link_snr;u[58]=s->link_antenna;u[59]=s->link_rf_mode;
 }
 u[60]=s->link_age_ms;u[61]=s->link_valid;
#if BLACKBOX_HAS_BAROMETER
 if(s->baro_valid){
  int32_t pressure;
  if(!isfinite(s->baro_pressure_pa)||s->baro_pressure_pa<30000.f||s->baro_pressure_pa>110000.f||!isfinite(s->baro_temp_c)||s->baro_temp_c< -40.f||s->baro_temp_c>85.f)return 0;
  if(!quant(s->baro_temp_c,100,&v[63])||!quant(s->baro_pressure_pa,1,&pressure))return 0;u[64]=(uint32_t)pressure;
  if(s->baro_alt_valid){int32_t reference;if(!quant(s->baro_alt_cm,1,&v[62])||!isfinite(s->baro_reference_pa)||s->baro_reference_pa<30000.f||s->baro_reference_pa>110000.f||!quant(s->baro_reference_pa,1,&reference))return 0;u[65]=(uint32_t)reference;}
 }
 u[66]=s->baro_age_ms;u[67]=s->baro_valid;u[68]=s->baro_alt_valid;u[69]=s->baro_sample;
#endif
 /* eRPM/100, truncated (integer division); validity is bfTelemOk. */
 for(unsigned m=0;m<4;m++)u[BLACKBOX_ERPM_INDEX+m]=s->erpm[m]/100u;
 u[BLACKBOX_ERPM_INDEX+4]=s->telem_ok;u[BLACKBOX_ERPM_INDEX+5]=s->filter_flags;u[BLACKBOX_ERPM_INDEX+6]=s->events;u[BLACKBOX_ERPM_INDEX+7]=s->loop_code;u[BLACKBOX_ERPM_INDEX+8]=s->overruns;
 uint8_t b[BLACKBOX_FRAME_MAX_BYTES];size_t n=0;b[n++]='I';for(unsigned i=0;i<FIELD_COUNT;i++){uint32_t bits=unsigned_field(i)?u[i]:((uint32_t)v[i]<<1)^(v[i]<0?UINT32_MAX:0u);n+=uv(b+n,bits);}if(cap<n)return 0;memcpy(dst,b,n);return n;
}
size_t blackbox_end(uint8_t *dst,size_t cap){static const uint8_t end[]={'E',255,'E','n','d',' ','o','f',' ','l','o','g',0};if(!dst||cap<sizeof end)return 0;memcpy(dst,end,sizeof end);return sizeof end;}
