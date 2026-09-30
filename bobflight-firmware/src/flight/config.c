/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#include "flight/config.h"
#include <string.h>
#include <math.h>
#define DEF_RATE_MAX 800.f
#define DEF_EXPO 0.30f
#define DEF_KP 0.002f
#define DEF_KI 0.001f
#define DEF_KD 0.00005f
#define DEF_MIN_THR 0.05f
#define DEF_AIRMODE 0
#define DEF_GYRO_LPF 320.f
#define DEF_DTERM_LPF 53.f
#define DEF_GYRO_NOTCH 0.f
#define DEF_GYRO_NOTCH_CUTOFF 0.f
static bf_config_t g_cfg={.rate_max_roll=DEF_RATE_MAX,.rate_max_pitch=DEF_RATE_MAX,.rate_max_yaw=DEF_RATE_MAX,.rate_expo=DEF_EXPO,.pid_roll_p=DEF_KP,.pid_roll_i=DEF_KI,.pid_roll_d=DEF_KD,.pid_pitch_p=DEF_KP,.pid_pitch_i=DEF_KI,.pid_pitch_d=DEF_KD,.pid_yaw_p=DEF_KP,.pid_yaw_i=DEF_KI,.pid_yaw_d=DEF_KD,.min_throttle=DEF_MIN_THR,.airmode=DEF_AIRMODE,.gyro_lpf_hz=DEF_GYRO_LPF,.dterm_lpf_hz=DEF_DTERM_LPF,.gyro_notch1_hz=DEF_GYRO_NOTCH,.gyro_notch1_cutoff_hz=DEF_GYRO_NOTCH_CUTOFF,.gyro_notch2_hz=DEF_GYRO_NOTCH,.gyro_notch2_cutoff_hz=DEF_GYRO_NOTCH_CUTOFF};
void config_defaults(void){g_cfg.rate_max_roll=DEF_RATE_MAX;g_cfg.rate_max_pitch=DEF_RATE_MAX;g_cfg.rate_max_yaw=DEF_RATE_MAX;g_cfg.rate_expo=DEF_EXPO;g_cfg.pid_roll_p=DEF_KP;g_cfg.pid_roll_i=DEF_KI;g_cfg.pid_roll_d=DEF_KD;g_cfg.pid_pitch_p=DEF_KP;g_cfg.pid_pitch_i=DEF_KI;g_cfg.pid_pitch_d=DEF_KD;g_cfg.pid_yaw_p=DEF_KP;g_cfg.pid_yaw_i=DEF_KI;g_cfg.pid_yaw_d=DEF_KD;g_cfg.min_throttle=DEF_MIN_THR;g_cfg.airmode=DEF_AIRMODE;g_cfg.gyro_lpf_hz=DEF_GYRO_LPF;g_cfg.dterm_lpf_hz=DEF_DTERM_LPF;g_cfg.gyro_notch1_hz=DEF_GYRO_NOTCH;g_cfg.gyro_notch1_cutoff_hz=DEF_GYRO_NOTCH_CUTOFF;g_cfg.gyro_notch2_hz=DEF_GYRO_NOTCH;g_cfg.gyro_notch2_cutoff_hz=DEF_GYRO_NOTCH_CUTOFF;}
void config_init(void){config_defaults();}
const bf_config_t *config_get(void){return &g_cfg;}
const bf_config_t *config_blob(void){return &g_cfg;}
void config_load_blob(const bf_config_t *src){if(src)g_cfg=*src;}
static float *slot_for(const char *key){if(!key)return NULL;if(!strcmp(key,"rate_max_roll"))return &g_cfg.rate_max_roll;if(!strcmp(key,"rate_max_pitch"))return &g_cfg.rate_max_pitch;if(!strcmp(key,"rate_max_yaw"))return &g_cfg.rate_max_yaw;if(!strcmp(key,"rate_expo"))return &g_cfg.rate_expo;if(!strcmp(key,"pid_roll_p"))return &g_cfg.pid_roll_p;if(!strcmp(key,"pid_roll_i"))return &g_cfg.pid_roll_i;if(!strcmp(key,"pid_roll_d"))return &g_cfg.pid_roll_d;if(!strcmp(key,"pid_pitch_p"))return &g_cfg.pid_pitch_p;if(!strcmp(key,"pid_pitch_i"))return &g_cfg.pid_pitch_i;if(!strcmp(key,"pid_pitch_d"))return &g_cfg.pid_pitch_d;if(!strcmp(key,"pid_yaw_p"))return &g_cfg.pid_yaw_p;if(!strcmp(key,"pid_yaw_i"))return &g_cfg.pid_yaw_i;if(!strcmp(key,"pid_yaw_d"))return &g_cfg.pid_yaw_d;if(!strcmp(key,"min_throttle"))return &g_cfg.min_throttle;if(!strcmp(key,"gyro_lpf_hz"))return &g_cfg.gyro_lpf_hz;if(!strcmp(key,"dterm_lpf_hz"))return &g_cfg.dterm_lpf_hz;if(!strcmp(key,"gyro_notch1_hz"))return &g_cfg.gyro_notch1_hz;if(!strcmp(key,"gyro_notch1_cutoff_hz"))return &g_cfg.gyro_notch1_cutoff_hz;if(!strcmp(key,"gyro_notch2_hz"))return &g_cfg.gyro_notch2_hz;if(!strcmp(key,"gyro_notch2_cutoff_hz"))return &g_cfg.gyro_notch2_cutoff_hz;return NULL;}
bool config_get_key(const char *key,float *out){if(!key||!out)return false;if(!strcmp(key,"airmode")){*out=(float)g_cfg.airmode;return true;}float *slot=slot_for(key);if(!slot)return false;*out=*slot;return true;}
/* Manual gyro notches (schema 8). The pair invariant always holds for a
 * nonzero centre, so a centre is only accepted with a valid cutoff already
 * stored: enable with cutoff first, then centre; change an enabled notch in
 * an order that keeps the pair valid at every step (the Configurator sends
 * cutoff first when the new cutoff is below the current centre, else centre
 * first), so it is never switched off on the way. */
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
bool config_set_key(const char *key,float value){if(!key||!isfinite(value))return false;if(!strcmp(key,"airmode")){if(value!=0.f&&value!=1.f)return false;g_cfg.airmode=(uint8_t)value;return true;}float *slot=slot_for(key);if(!slot)return false;if(!strncmp(key,"rate_max_",9)){if(value<10.f||value>2000.f)return false;}else if(!strcmp(key,"rate_expo")){if(value<0.f||value>1.f)return false;}else if(!strcmp(key,"min_throttle")){if(value<0.f||value>0.2f)return false;}else if(!strcmp(key,"gyro_lpf_hz")||!strcmp(key,"dterm_lpf_hz")){if(value!=0.f&&(value<10.f||value>1000.f))return false;}else if(!strncmp(key,"gyro_notch",10)){if(!notch_key_ok(key,value))return false;}else if(value<0.f||value>10.f)return false;*slot=value;return true;}
