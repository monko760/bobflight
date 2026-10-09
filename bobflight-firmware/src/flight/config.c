/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "flight/config.h"
#include <string.h>
#include <math.h>
#define DEF_RATE_MAX 800.f
#define DEF_KP 0.002f
#define DEF_KI 0.001f
#define DEF_KD 0.00005f
#define DEF_MIN_THR 0.05f
#define DEF_AIRMODE 0
#define DEF_GYRO_LPF 320.f
#define DEF_DTERM_LPF 53.f
#define DEF_GYRO_NOTCH 0.f
#define DEF_GYRO_NOTCH_CUTOFF 0.f
#define DEF_RPM_HARMONICS 0.f
#define DEF_RPM_MIN_HZ 100.f
#define DEF_RPM_Q_X100 500.f
#define DEF_MOTOR_POLES 14.f
#define DEF_RATE_CENTER 200.f
#define DEF_RATE_EXPO_AXIS 0.30f

/* Schema 10 motor_direction: props-out (default) keeps the mixer yaw signs. */
static motor_direction_t g_motor_direction=MOTOR_DIRECTION_PROPS_OUT;
static bf_config_t g_cfg={
 .rate_max_roll=DEF_RATE_MAX,.rate_max_pitch=DEF_RATE_MAX,.rate_max_yaw=DEF_RATE_MAX,
 .pid_roll_p=DEF_KP,.pid_roll_i=DEF_KI,.pid_roll_d=DEF_KD,
 .pid_pitch_p=DEF_KP,.pid_pitch_i=DEF_KI,.pid_pitch_d=DEF_KD,
 .pid_yaw_p=DEF_KP,.pid_yaw_i=DEF_KI,.pid_yaw_d=DEF_KD,
 .min_throttle=DEF_MIN_THR,.airmode=DEF_AIRMODE,.gyro_lpf_hz=DEF_GYRO_LPF,.dterm_lpf_hz=DEF_DTERM_LPF,
 .gyro_notch1_hz=DEF_GYRO_NOTCH,.gyro_notch1_cutoff_hz=DEF_GYRO_NOTCH_CUTOFF,
 .gyro_notch2_hz=DEF_GYRO_NOTCH,.gyro_notch2_cutoff_hz=DEF_GYRO_NOTCH_CUTOFF,
 .rpm_filter_harmonics=DEF_RPM_HARMONICS,.rpm_filter_min_hz=DEF_RPM_MIN_HZ,.rpm_filter_q_x100=DEF_RPM_Q_X100,.motor_poles=DEF_MOTOR_POLES,
 .align_board_roll=0.f,.align_board_pitch=0.f,.align_board_yaw=0.f,
 .rate_center_roll=DEF_RATE_CENTER,.rate_center_pitch=DEF_RATE_CENTER,.rate_center_yaw=DEF_RATE_CENTER,
 .rate_expo_roll=DEF_RATE_EXPO_AXIS,.rate_expo_pitch=DEF_RATE_EXPO_AXIS,.rate_expo_yaw=DEF_RATE_EXPO_AXIS
};

static const char *const g_config_keys[] = {
 "rate_max_roll","rate_max_pitch","rate_max_yaw",
 "pid_roll_p","pid_roll_i","pid_roll_d",
 "pid_pitch_p","pid_pitch_i","pid_pitch_d",
 "pid_yaw_p","pid_yaw_i","pid_yaw_d",
 "min_throttle","airmode","gyro_lpf_hz","dterm_lpf_hz",
 "gyro_notch1_hz","gyro_notch1_cutoff_hz","gyro_notch2_hz","gyro_notch2_cutoff_hz",
 "rpm_filter_harmonics","rpm_filter_min_hz","rpm_filter_q_x100","motor_poles",
 "align_board_roll","align_board_pitch","align_board_yaw",
 "rate_center_roll","rate_center_pitch","rate_center_yaw",
 "rate_expo_roll","rate_expo_pitch","rate_expo_yaw"
};

size_t config_key_count(void){return sizeof(g_config_keys)/sizeof(g_config_keys[0]);}
const char *config_key_name(size_t idx){if(idx<config_key_count())return g_config_keys[idx];return NULL;}

void config_defaults(void){
 g_cfg.rate_max_roll=DEF_RATE_MAX;g_cfg.rate_max_pitch=DEF_RATE_MAX;g_cfg.rate_max_yaw=DEF_RATE_MAX;
 g_cfg.pid_roll_p=DEF_KP;g_cfg.pid_roll_i=DEF_KI;g_cfg.pid_roll_d=DEF_KD;
 g_cfg.pid_pitch_p=DEF_KP;g_cfg.pid_pitch_i=DEF_KI;g_cfg.pid_pitch_d=DEF_KD;
 g_cfg.pid_yaw_p=DEF_KP;g_cfg.pid_yaw_i=DEF_KI;g_cfg.pid_yaw_d=DEF_KD;
 g_cfg.min_throttle=DEF_MIN_THR;g_cfg.airmode=DEF_AIRMODE;g_cfg.gyro_lpf_hz=DEF_GYRO_LPF;g_cfg.dterm_lpf_hz=DEF_DTERM_LPF;
 g_cfg.gyro_notch1_hz=DEF_GYRO_NOTCH;g_cfg.gyro_notch1_cutoff_hz=DEF_GYRO_NOTCH_CUTOFF;
 g_cfg.gyro_notch2_hz=DEF_GYRO_NOTCH;g_cfg.gyro_notch2_cutoff_hz=DEF_GYRO_NOTCH_CUTOFF;
 g_cfg.rpm_filter_harmonics=DEF_RPM_HARMONICS;g_cfg.rpm_filter_min_hz=DEF_RPM_MIN_HZ;g_cfg.rpm_filter_q_x100=DEF_RPM_Q_X100;g_cfg.motor_poles=DEF_MOTOR_POLES;
 g_cfg.align_board_roll=g_cfg.align_board_pitch=g_cfg.align_board_yaw=0.f;
 g_cfg.rate_center_roll=DEF_RATE_CENTER;g_cfg.rate_center_pitch=DEF_RATE_CENTER;g_cfg.rate_center_yaw=DEF_RATE_CENTER;
 g_cfg.rate_expo_roll=DEF_RATE_EXPO_AXIS;g_cfg.rate_expo_pitch=DEF_RATE_EXPO_AXIS;g_cfg.rate_expo_yaw=DEF_RATE_EXPO_AXIS;
 g_motor_direction=MOTOR_DIRECTION_PROPS_OUT;
}

bool config_get_default_key(const char *key,float *out){
 if(!key||!out)return false;
 if(!strcmp(key,"rate_max_roll")||!strcmp(key,"rate_max_pitch")||!strcmp(key,"rate_max_yaw")){*out=DEF_RATE_MAX;return true;}
 if(!strcmp(key,"pid_roll_p")||!strcmp(key,"pid_pitch_p")||!strcmp(key,"pid_yaw_p")){*out=DEF_KP;return true;}
 if(!strcmp(key,"pid_roll_i")||!strcmp(key,"pid_pitch_i")||!strcmp(key,"pid_yaw_i")){*out=DEF_KI;return true;}
 if(!strcmp(key,"pid_roll_d")||!strcmp(key,"pid_pitch_d")||!strcmp(key,"pid_yaw_d")){*out=DEF_KD;return true;}
 if(!strcmp(key,"min_throttle")){*out=DEF_MIN_THR;return true;}
 if(!strcmp(key,"airmode")){*out=(float)DEF_AIRMODE;return true;}
 if(!strcmp(key,"gyro_lpf_hz")){*out=DEF_GYRO_LPF;return true;}
 if(!strcmp(key,"dterm_lpf_hz")){*out=DEF_DTERM_LPF;return true;}
 if(!strcmp(key,"gyro_notch1_hz")||!strcmp(key,"gyro_notch1_cutoff_hz")||!strcmp(key,"gyro_notch2_hz")||!strcmp(key,"gyro_notch2_cutoff_hz")){*out=0.f;return true;}
 if(!strcmp(key,"rpm_filter_harmonics")){*out=DEF_RPM_HARMONICS;return true;}
 if(!strcmp(key,"rpm_filter_min_hz")){*out=DEF_RPM_MIN_HZ;return true;}
 if(!strcmp(key,"rpm_filter_q_x100")){*out=DEF_RPM_Q_X100;return true;}
 if(!strcmp(key,"motor_poles")){*out=DEF_MOTOR_POLES;return true;}
 if(!strcmp(key,"align_board_roll")||!strcmp(key,"align_board_pitch")||!strcmp(key,"align_board_yaw")){*out=0.f;return true;}
 if(!strcmp(key,"rate_center_roll")||!strcmp(key,"rate_center_pitch")||!strcmp(key,"rate_center_yaw")){*out=DEF_RATE_CENTER;return true;}
 if(!strcmp(key,"rate_expo_roll")||!strcmp(key,"rate_expo_pitch")||!strcmp(key,"rate_expo_yaw")){*out=DEF_RATE_EXPO_AXIS;return true;}
 return false;
}

bool config_get_default(const char *key,float *out){return config_get_default_key(key,out);}

motor_direction_t config_motor_direction(void){return g_motor_direction;}
bool config_set_motor_direction(motor_direction_t d){if(d!=MOTOR_DIRECTION_PROPS_OUT&&d!=MOTOR_DIRECTION_PROPS_IN)return false;g_motor_direction=d;return true;}
const char *config_motor_direction_name(motor_direction_t d){return d==MOTOR_DIRECTION_PROPS_OUT?"props-out":d==MOTOR_DIRECTION_PROPS_IN?"props-in":NULL;}
bool config_motor_direction_parse(const char *t,motor_direction_t *out){
 if(!t||!out)return false;
 if(!strcmp(t,"props-out")){*out=MOTOR_DIRECTION_PROPS_OUT;return true;}
 if(!strcmp(t,"props-in")){*out=MOTOR_DIRECTION_PROPS_IN;return true;}
 return false;
}
static float g_alignment_active[3];
static float g_alignment_matrix[9]={1,0,0,0,1,0,0,0,1};
static bool g_alignment_enabled;
bool config_board_alignment_value_valid(float v){return isfinite(v)&&v>=-180.f&&v<=180.f&&v==floorf(v);}
const float *config_board_alignment_active(void){return g_alignment_active;}
bool config_board_alignment_pending(void){return g_alignment_active[0]!=g_cfg.align_board_roll||g_alignment_active[1]!=g_cfg.align_board_pitch||g_alignment_active[2]!=g_cfg.align_board_yaw;}
void config_board_alignment_activate(void){
 const float k=0.01745329251994329577f;
 const float r=g_cfg.align_board_roll*k,p=g_cfg.align_board_pitch*k,y=g_cfg.align_board_yaw*k;
 const float cr=cosf(r),sr=sinf(r),cp=cosf(p),sp=sinf(p),cy=cosf(y),sy=sinf(y);
 const float m[9]={cy*cp,cy*sp*sr-sy*cr,cy*sp*cr+sy*sr,
                  sy*cp,sy*sp*sr+cy*cr,sy*sp*cr-cy*sr,-sp,cp*sr,cp*cr};
 for(unsigned i=0;i<9;i++)g_alignment_matrix[i]=fabsf(m[i])<0.000001f?0.f:m[i];
 g_alignment_active[0]=g_cfg.align_board_roll;g_alignment_active[1]=g_cfg.align_board_pitch;g_alignment_active[2]=g_cfg.align_board_yaw;
 g_alignment_enabled=g_alignment_active[0]!=0.f||g_alignment_active[1]!=0.f||g_alignment_active[2]!=0.f;
}
void config_board_alignment_apply(float v[3]){
 if(!g_alignment_enabled)return;
 const float x=v[0],y=v[1],z=v[2];
 for(unsigned i=0;i<3;i++)v[i]=g_alignment_matrix[3*i]*x+g_alignment_matrix[3*i+1]*y+g_alignment_matrix[3*i+2]*z;
}
void config_init(void){config_defaults();config_board_alignment_activate();}
const bf_config_t *config_get(void){return &g_cfg;}
const bf_config_t *config_blob(void){return &g_cfg;}
void config_load_blob(const bf_config_t *src){if(src)g_cfg=*src;}

static float *slot_for(const char *key){
 if(!key)return NULL;
 if(!strcmp(key,"rate_max_roll"))return &g_cfg.rate_max_roll;
 if(!strcmp(key,"rate_max_pitch"))return &g_cfg.rate_max_pitch;
 if(!strcmp(key,"rate_max_yaw"))return &g_cfg.rate_max_yaw;
 if(!strcmp(key,"pid_roll_p"))return &g_cfg.pid_roll_p;
 if(!strcmp(key,"pid_roll_i"))return &g_cfg.pid_roll_i;
 if(!strcmp(key,"pid_roll_d"))return &g_cfg.pid_roll_d;
 if(!strcmp(key,"pid_pitch_p"))return &g_cfg.pid_pitch_p;
 if(!strcmp(key,"pid_pitch_i"))return &g_cfg.pid_pitch_i;
 if(!strcmp(key,"pid_pitch_d"))return &g_cfg.pid_pitch_d;
 if(!strcmp(key,"pid_yaw_p"))return &g_cfg.pid_yaw_p;
 if(!strcmp(key,"pid_yaw_i"))return &g_cfg.pid_yaw_i;
 if(!strcmp(key,"pid_yaw_d"))return &g_cfg.pid_yaw_d;
 if(!strcmp(key,"min_throttle"))return &g_cfg.min_throttle;
 if(!strcmp(key,"gyro_lpf_hz"))return &g_cfg.gyro_lpf_hz;
 if(!strcmp(key,"dterm_lpf_hz"))return &g_cfg.dterm_lpf_hz;
 if(!strcmp(key,"gyro_notch1_hz"))return &g_cfg.gyro_notch1_hz;
 if(!strcmp(key,"gyro_notch1_cutoff_hz"))return &g_cfg.gyro_notch1_cutoff_hz;
 if(!strcmp(key,"gyro_notch2_hz"))return &g_cfg.gyro_notch2_hz;
 if(!strcmp(key,"gyro_notch2_cutoff_hz"))return &g_cfg.gyro_notch2_cutoff_hz;
 if(!strcmp(key,"rpm_filter_harmonics"))return &g_cfg.rpm_filter_harmonics;
 if(!strcmp(key,"rpm_filter_min_hz"))return &g_cfg.rpm_filter_min_hz;
 if(!strcmp(key,"rpm_filter_q_x100"))return &g_cfg.rpm_filter_q_x100;
 if(!strcmp(key,"motor_poles"))return &g_cfg.motor_poles;
 if(!strcmp(key,"align_board_roll"))return &g_cfg.align_board_roll;
 if(!strcmp(key,"align_board_pitch"))return &g_cfg.align_board_pitch;
 if(!strcmp(key,"align_board_yaw"))return &g_cfg.align_board_yaw;
 if(!strcmp(key,"rate_center_roll"))return &g_cfg.rate_center_roll;
 if(!strcmp(key,"rate_center_pitch"))return &g_cfg.rate_center_pitch;
 if(!strcmp(key,"rate_center_yaw"))return &g_cfg.rate_center_yaw;
 if(!strcmp(key,"rate_expo_roll"))return &g_cfg.rate_expo_roll;
 if(!strcmp(key,"rate_expo_pitch"))return &g_cfg.rate_expo_pitch;
 if(!strcmp(key,"rate_expo_yaw"))return &g_cfg.rate_expo_yaw;
 return NULL;
}

bool config_get_key(const char *key,float *out){
 if(!key||!out)return false;
 if(!strcmp(key,"airmode")){*out=(float)g_cfg.airmode;return true;}
 float *slot=slot_for(key);
 if(!slot)return false;
 *out=*slot;
 return true;
}

#define NOTCH_CENTER_MIN 20.f
#define NOTCH_CENTER_MAX 1000.f
bool config_gyro_notch_pair_valid(float c,float f){
 if(!isfinite(c)||!isfinite(f))return false;
 if(c==0.f)return f>=0.f&&f<NOTCH_CENTER_MAX;
 return c>=NOTCH_CENTER_MIN&&c<=NOTCH_CENTER_MAX&&f>0.f&&f<c;
}
static float *notch_center(unsigned idx){return idx==1?&g_cfg.gyro_notch1_hz:idx==2?&g_cfg.gyro_notch2_hz:NULL;}
static float *notch_cutoff(unsigned idx){return idx==1?&g_cfg.gyro_notch1_cutoff_hz:idx==2?&g_cfg.gyro_notch2_cutoff_hz:NULL;}
static bool notch_key_ok(const char *key,float value){
 unsigned idx=key[10]=='1'?1u:key[10]=='2'?2u:0u;
 if(!idx)return false;
 if(!strcmp(key+11,"_hz"))return config_gyro_notch_pair_valid(value,*notch_cutoff(idx));
 if(!strcmp(key+11,"_cutoff_hz"))return config_gyro_notch_pair_valid(*notch_center(idx),value);
 return false;
}
bool config_set_gyro_notch(unsigned idx,float c,float f){
 float *pc=notch_center(idx),*pf=notch_cutoff(idx);
 if(!pc||!pf||!config_gyro_notch_pair_valid(c,f))return false;
 *pc=c;*pf=f;return true;
}
bool config_is_rpm_key(const char *key){return key&&(!strcmp(key,"rpm_filter_harmonics")||!strcmp(key,"rpm_filter_min_hz")||!strcmp(key,"rpm_filter_q_x100")||!strcmp(key,"motor_poles"));}
bool config_rpm_value_valid(const char *key,float v){
 if(!config_is_rpm_key(key)||!isfinite(v)||v!=floorf(v))return false;
 if(!strcmp(key,"rpm_filter_harmonics"))return v>=0.f&&v<=3.f;
 if(!strcmp(key,"rpm_filter_min_hz"))return v>=50.f&&v<=200.f;
 if(!strcmp(key,"rpm_filter_q_x100"))return v>=100.f&&v<=1000.f;
 return v>=4.f&&v<=36.f&&fmodf(v,2.f)==0.f;
}

bool config_set_key(const char *key,float value){
 if(!key||!isfinite(value))return false;
 if(!strcmp(key,"airmode")){
  if(value!=0.f&&value!=1.f)return false;
  g_cfg.airmode=(uint8_t)value;
  return true;
 }
 float *slot=slot_for(key);
 if(!slot)return false;

 if(!strncmp(key,"rate_center_",12)){
  if(value<0.f||value>2000.f)return false;
 }else if(!strncmp(key,"rate_expo_",10)){
  if(value<0.f||value>1.f)return false;
 }else if(!strncmp(key,"rate_max_",9)){
  if(value<10.f||value>2000.f)return false;

 }else if(!strcmp(key,"min_throttle")){
  if(value<0.f||value>0.2f)return false;
 }else if(!strcmp(key,"gyro_lpf_hz")||!strcmp(key,"dterm_lpf_hz")){
  if(value!=0.f&&(value<10.f||value>1000.f))return false;
 }else if(!strncmp(key,"gyro_notch",10)){
  if(!notch_key_ok(key,value))return false;
 }else if(!strncmp(key,"align_board_",12)){
  if(!config_board_alignment_value_valid(value))return false;
 }else if(config_is_rpm_key(key)){
  if(!config_rpm_value_valid(key,value))return false;
 }else if(value<0.f||value>10.f)return false;

 *slot=value;
 return true;
}
