/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * D1 scoped defaults: the real `defaults <group>` CLI handler (defaults_cli.h)
 * against the real config.c, loop-rate setting and persist.c encode/decode.
 * Setup: props-in, align yaw 90 (saved + reloaded, active), loop 1000, valid
 * accel calibration. Each group: defaults <g> + save + reload keeps all four,
 * accel_cal_saved stays yes, group keys equal defaults, reply lines exact.
 * Refusals: byte-identical state and dirty flag, in the frozen order.
 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "drivers/config_store.h"
#include "drivers/gyro.h"
#include "drivers/sensor_calibration.h"
#include "board/board.h"
#include "flight/arming.h"
#include "sched/tasks.h"
#include "flight/mode_range.h"
#include "sched/loop_rate_setting.h"
static board_t board={.board_id="kakute_f7_hdv",.rx_uart=6};
static bool armed,bench,calibrating,supported=true,exists,write_failure,read_failure;
static unsigned saves,rx_resets,freshness_resets,generation;
static uint8_t image[256];static size_t image_len;static uint32_t image_board;static uint32_t image_schema=13;
const board_t *board_get(void){return &board;}
bool board_select_rx_uart(unsigned u){if(!(u==1||u==2||u==3||u==4||u==6||u==7))return false;board.rx_uart=u;return true;}
arm_state_t arming_state(void){return armed?ARM_ARMED:ARM_DISARMED;}
bool bench_motor_active(void){return bench;}
bool gyro_manual_calibration_active(void){return calibrating;}
static control_mode_t manual_mode=CONTROL_MODE_ANGLE;
control_mode_t control_mode_get(void){return manual_mode;}
bool control_mode_set(control_mode_t mode){manual_mode=mode;return true;}
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
static bool aux_source;
const char *control_source_name(void){return aux_source?"aux":"manual";}
bool control_source_set(bool aux){aux_source=aux;return true;}
#endif
static const char *map="AETR";
const char *crsf_map(void){return map;}
bool crsf_set_map(const char *m){if(strcmp(m,"AETR")&&strcmp(m,"TAER"))return false;map=!strcmp(m,"TAER")?"TAER":"AETR";return true;}
void failsafe_reset_rx_link(void){freshness_resets++;}
void rx_init(void){rx_resets++;}
static bool restored_fresh;
bool rx_frame_fresh(void){return restored_fresh;}
static float restored_rc[16];
const float *rx_channels(void){return restored_rc;}
bool config_store_supported(void){return supported;}
const char *config_store_backend(void){return supported?"host_sim":"unsupported";}
uint32_t config_store_generation(void){return generation;}
config_store_result_t config_store_load(uint32_t id,void *p,size_t n){if(!supported)return CONFIG_STORE_UNSUPPORTED;if(read_failure)return CONFIG_STORE_IO_ERROR;if(!exists)return CONFIG_STORE_EMPTY;if(image_schema!=13)return CONFIG_STORE_INCOMPATIBLE;if(n!=image_len||id!=image_board)return CONFIG_STORE_INVALID;memcpy(p,image,n);return CONFIG_STORE_OK;}
config_store_result_t config_store_save(uint32_t id,const void *p,size_t n){saves++;if(!supported)return CONFIG_STORE_UNSUPPORTED;if(write_failure)return CONFIG_STORE_IO_ERROR;if(exists&&image_schema!=13)return CONFIG_STORE_INCOMPATIBLE;if(!exists||n!=image_len||memcmp(p,image,n))generation++;memcpy(image,p,n);image_len=n;image_board=id;exists=true;return CONFIG_STORE_OK;}
static gyro_calibration_info_t cal;
void gyro_calibration_info(gyro_calibration_info_t *out){*out=cal;}
uint32_t gyro_accel_calibration_binding(void){return 0x01006810u;}
bool gyro_accel_restore_valid(const float b[3],const float v[3],uint32_t binding){return binding==gyro_accel_calibration_binding()&&sc_accel_coefficients_valid(b,v);}
void gyro_restore_accel_calibration(const float b[3],const float v[3],bool valid){memcpy(cal.accel_bias,b,12);memcpy(cal.accel_scale,v,12);cal.accel_valid=valid;}
uint32_t config_store_loaded_schema(void){return image_schema;}
#include "drivers/power.h"
#include "hal/hal.h"
void hal_power_adc_init(hal_pin_t a,hal_pin_t b){(void)a;(void)b;}
bool hal_power_adc_poll(uint16_t*a,uint16_t*b){(void)a;(void)b;return false;}
uint32_t hal_millis(void){return 0;}
static unsigned speed=300;static bool speed_failure;
unsigned dshot_speed_kbps(void){return speed;}
bool dshot_set_speed_kbps(unsigned v){if(speed_failure)return false;speed=v;return true;}
#include "../src/drivers/persist.c"
static char out[4096];
static void cli_write_str(const char *s){assert(strlen(out)+strlen(s)<sizeof out);strcat(out,s);}
#include "../src/drivers/defaults_cli.h"

static int failures;
#define CHECK(c,...) do{if(!(c)){fprintf(stderr,"FAIL %s:%d: ",__FILE__,__LINE__);fprintf(stderr,__VA_ARGS__);fputc('\n',stderr);failures++;}}while(0)

static void run(const char *line){out[0]=0;char buf[64];snprintf(buf,sizeof buf,"%s",line);CHECK(cmd_defaults(buf),"not handled: %s",line);}
static void reboot(void){ /* boot order: init, load, activate alignment */
 persist_init();memset(&cal,0,sizeof cal);manual_mode=CONTROL_MODE_ANGLE;board.rx_uart=6;(void)crsf_set_map("AETR");
 CHECK(persist_load(),"load failed: %s",persist_last_error());config_board_alignment_activate();
}
static const char *NON_GROUP_KEYS[]={"motor_poles","align_board_roll","align_board_pitch","align_board_yaw"};
/* Non-default values for every grouped key (all valid together). */
static const struct{const char*k;float v;}TUNED[]={
 {"pid_roll_p",.004f},{"pid_roll_i",.003f},{"pid_roll_d",.0002f},{"pid_pitch_p",.005f},{"pid_pitch_i",.002f},{"pid_pitch_d",.0003f},
 {"pid_yaw_p",.006f},{"pid_yaw_i",.0025f},{"pid_yaw_d",.0004f},{"min_throttle",.1f},{"airmode",1},
 {"rate_center_roll",150},{"rate_center_pitch",160},{"rate_center_yaw",170},{"rate_max_roll",600},{"rate_max_pitch",650},{"rate_max_yaw",700},
 {"rate_expo_roll",.5f},{"rate_expo_pitch",.6f},{"rate_expo_yaw",.7f},
 {"gyro_lpf_hz",250},{"dterm_lpf_hz",90},{"gyro_notch1_cutoff_hz",150},{"gyro_notch1_hz",200},{"gyro_notch2_cutoff_hz",300},{"gyro_notch2_hz",400},
 {"rpm_filter_harmonics",2},{"rpm_filter_min_hz",120},{"rpm_filter_q_x100",600}};
static void tune(void){for(size_t i=0;i<sizeof TUNED/sizeof TUNED[0];i++)CHECK(config_set_key(TUNED[i].k,TUNED[i].v),"tune %s",TUNED[i].k);CHECK(config_set_key("motor_poles",12),"poles");}
static float tuned(const char *k){for(size_t i=0;i<sizeof TUNED/sizeof TUNED[0];i++)if(!strcmp(TUNED[i].k,k))return TUNED[i].v;return -1;}
static bool in_group(const char *g,const char *k){size_t n;const char *const *ks=config_defaults_group_keys(g,&n);for(size_t i=0;ks&&i<n;i++)if(!strcmp(ks[i],k))return true;return false;}
static const char *GROUPS[]={"pid","rates","filters"};
static const size_t COUNTS[]={11,9,9};
static const char *EXPECT[3]=
{"defaults_group: pid\r\n"
 "defaults_key: pid_roll_p=0.002\r\ndefaults_key: pid_roll_i=0.001\r\ndefaults_key: pid_roll_d=5e-05\r\n"
 "defaults_key: pid_pitch_p=0.002\r\ndefaults_key: pid_pitch_i=0.001\r\ndefaults_key: pid_pitch_d=5e-05\r\n"
 "defaults_key: pid_yaw_p=0.002\r\ndefaults_key: pid_yaw_i=0.001\r\ndefaults_key: pid_yaw_d=5e-05\r\n"
 "defaults_key: min_throttle=0.05\r\ndefaults_key: airmode=0\r\n"
 "defaults_end: pid 11\r\n",
 "defaults_group: rates\r\n"
 "defaults_key: rate_center_roll=200\r\ndefaults_key: rate_center_pitch=200\r\ndefaults_key: rate_center_yaw=200\r\n"
 "defaults_key: rate_max_roll=800\r\ndefaults_key: rate_max_pitch=800\r\ndefaults_key: rate_max_yaw=800\r\n"
 "defaults_key: rate_expo_roll=0.3\r\ndefaults_key: rate_expo_pitch=0.3\r\ndefaults_key: rate_expo_yaw=0.3\r\n"
 "defaults_end: rates 9\r\n",
 "defaults_group: filters\r\n"
 "defaults_key: gyro_lpf_hz=320\r\ndefaults_key: dterm_lpf_hz=53\r\n"
 "defaults_key: gyro_notch1_hz=0\r\ndefaults_key: gyro_notch1_cutoff_hz=0\r\ndefaults_key: gyro_notch2_hz=0\r\ndefaults_key: gyro_notch2_cutoff_hz=0\r\n"
 "defaults_key: rpm_filter_harmonics=0\r\ndefaults_key: rpm_filter_min_hz=100\r\ndefaults_key: rpm_filter_q_x100=500\r\n"
 "defaults_end: filters 9\r\n"};

/* Byte-level snapshot of everything a refusal must not change. */
typedef struct{bf_config_t cfg;motor_direction_t dir;uint32_t loop;gyro_calibration_info_t cal;uint8_t saved[256];bool have_saved,dirty;const char *err;float active[3];}snap_t;
static void take(snap_t *s){memset(s,0,sizeof *s);s->cfg=*config_get();s->dir=config_motor_direction();s->loop=loop_rate_setting_get();s->cal=cal;memcpy(s->saved,saved,256);s->have_saved=have_saved;s->dirty=persist_dirty();s->err=persist_last_error();memcpy(s->active,config_board_alignment_active(),12);}
static bool same(const snap_t *a,const snap_t *b){return !memcmp(&a->cfg,&b->cfg,sizeof a->cfg)&&a->dir==b->dir&&a->loop==b->loop&&!memcmp(&a->cal,&b->cal,sizeof a->cal)&&!memcmp(a->saved,b->saved,256)&&a->have_saved==b->have_saved&&a->dirty==b->dirty&&a->err==b->err&&!memcmp(a->active,b->active,12);}
static void refused(const char *line,const char *want){
 snap_t before,after;take(&before);unsigned s0=saves;run(line);take(&after);
 CHECK(!strcmp(out,want),"'%s' -> '%s' want '%s'",line,out,want);
 CHECK(same(&before,&after)&&saves==s0,"'%s' changed state (dirty %d->%d)",line,before.dirty,after.dirty);
}
static void key_lines_match_count(const char *reply,const char *g){
 unsigned lines=0;const char *p=reply;while((p=strstr(p,"defaults_key: "))){lines++;p++;}
 char end[64];snprintf(end,sizeof end,"defaults_end: %s %u\r\n",g,lines);
 CHECK(strstr(reply,end)!=NULL,"end count != %u key lines in %s",lines,reply);
}

int main(void){
 power_init();persist_init();
 /* Setup: props-in, yaw 90, loop 1000, valid accel cal; save + reload so 90 is active. */
 CHECK(config_set_motor_direction(MOTOR_DIRECTION_PROPS_IN),"dir");CHECK(config_set_key("align_board_yaw",90),"yaw");CHECK(loop_rate_setting_set(1000),"loop");
 CHECK(crsf_set_map("TAER"),"map");board.rx_uart=2;speed=600;
 cal.accel_valid=true;for(unsigned i=0;i<3;i++){cal.accel_bias[i]=.01f*(i+1);cal.accel_scale[i]=1.f+.001f*i;}
 CHECK(persist_save(),"setup save: %s",persist_last_error());
 /* yaw 90 is requested but not active yet: this first save deliberately drops the old-frame cal. */
 CHECK(!persist_accel_calibration_saved(),"pending alignment must exclude cal");
 reboot();CHECK(config_board_alignment_active()[2]==90,"yaw active");
 cal.accel_valid=true;for(unsigned i=0;i<3;i++){cal.accel_bias[i]=.01f*(i+1);cal.accel_scale[i]=1.f+.001f*i;} /* recalibrate in the new frame */
 CHECK(persist_save()&&persist_accel_calibration_saved(),"cal save");reboot();
 CHECK(cal.accel_valid&&persist_accel_calibration_saved(),"cal restored after reload");

 for(unsigned g=0;g<3;g++){
  tune();CHECK(persist_save()&&!persist_dirty(),"save tuned");reboot();
  CHECK(!persist_dirty(),"clean after reload");
  char cmd[32];snprintf(cmd,sizeof cmd,"defaults %s",GROUPS[g]);unsigned s0=saves;run(cmd);
  CHECK(!strcmp(out,EXPECT[g]),"%s reply:\n%s",GROUPS[g],out);
  key_lines_match_count(out,GROUPS[g]);
  size_t n;config_defaults_group_keys(GROUPS[g],&n);CHECK(n==COUNTS[g],"%s count %zu",GROUPS[g],n);
  CHECK(persist_dirty()&&!strcmp(persist_state(),"dirty"),"%s: storage must go dirty (no auto-save)",GROUPS[g]);
  CHECK(saves==s0,"%s: defaults must not auto-save",GROUPS[g]);
  CHECK(persist_save(),"%s save: %s",GROUPS[g],persist_last_error());
  CHECK(persist_accel_calibration_saved(),"%s: accel_cal_saved must stay yes",GROUPS[g]);
  reboot();
  CHECK(config_motor_direction()==MOTOR_DIRECTION_PROPS_IN,"%s: props-in lost",GROUPS[g]);
  CHECK(config_get()->align_board_yaw==90&&config_board_alignment_active()[2]==90,"%s: align yaw lost",GROUPS[g]);
  CHECK(loop_rate_setting_get()==1000,"%s: loop rate lost",GROUPS[g]);
  CHECK(cal.accel_valid&&cal.accel_bias[2]==.03f&&cal.accel_scale[1]==1.001f,"%s: accel cal lost",GROUPS[g]);
  CHECK(persist_accel_calibration_saved(),"%s: accel_cal_saved after reload",GROUPS[g]);
  CHECK(speed==600&&!strcmp(crsf_map(),"TAER")&&board.rx_uart==2,"%s: dshot/map/uart changed",GROUPS[g]);
  float v;CHECK(config_get_key("motor_poles",&v)&&v==12,"%s: motor_poles reset",GROUPS[g]);
  for(size_t i=0;i<sizeof TUNED/sizeof TUNED[0];i++){float d;CHECK(config_get_key(TUNED[i].k,&v),"get");
   if(in_group(GROUPS[g],TUNED[i].k)){CHECK(config_get_default_key(TUNED[i].k,&d)&&v==d,"%s: %s=%g not default",GROUPS[g],TUNED[i].k,v);}
   else CHECK(v==tuned(TUNED[i].k),"%s touched %s (%g)",GROUPS[g],TUNED[i].k,v);}
  for(size_t i=0;i<4;i++)CHECK(!in_group(GROUPS[g],NON_GROUP_KEYS[i]),"%s lists %s",GROUPS[g],NON_GROUP_KEYS[i]);
 }

 /* Refusals: exact line, nothing changes (config, cal, saved record, dirty flag). Make state dirty first. */
 CHECK(config_set_key("pid_roll_p",.009f),"dirty");
 refused("defaults","defaults_error: group_required pid|rates|filters\r\n");
 refused("defaults foo","defaults_error: unknown_group\r\n");
 refused("defaults PID","defaults_error: unknown_group\r\n");
 refused("defaults pid rates","defaults_error: unknown_group\r\n");
 refused("defaults ","defaults_error: unknown_group\r\n");
 refused("defaults all","defaults_error: unknown_group\r\n");
 /* Order: safety before group checks; armed > bench > calibration. */
 armed=true;refused("defaults pid","defaults_error: armed\r\n");refused("defaults","defaults_error: armed\r\n");refused("defaults foo","defaults_error: armed\r\n");
 bench=true;calibrating=true;refused("defaults pid","defaults_error: armed\r\n");armed=false;
 refused("defaults rates","defaults_error: bench_active\r\n");refused("defaults","defaults_error: bench_active\r\n");bench=false;
 refused("defaults filters","defaults_error: calibration_active\r\n");refused("defaults foo","defaults_error: calibration_active\r\n");calibrating=false;
 /* Clean-state refusal keeps dirty=0 too. */
 CHECK(persist_save()&&!persist_dirty(),"clean");refused("defaults","defaults_error: group_required pid|rates|filters\r\n");
 armed=true;refused("defaults pid","defaults_error: armed\r\n");armed=false;
 /* Non-defaults lines are not ours. */
 {char b[16]="defaultsx";out[0]=0;CHECK(!cmd_defaults(b)&&!out[0],"defaultsx handled");}
 CHECK(config_defaults_group_keys("x",NULL)==NULL&&!config_defaults_group(NULL),"unknown group API");
 /* Boot defaults and per-key defaults are one table: config_defaults() must equal
  * config_get_default_key() bit for bit for every config key (the 29 grouped keys
  * plus motor_poles and align_board_*), and set motor_direction to props-out. */
 {tune();CHECK(config_set_key("align_board_roll",180)&&config_set_key("align_board_pitch",-90)&&config_set_key("align_board_yaw",45),"align");
  CHECK(config_set_motor_direction(MOTOR_DIRECTION_PROPS_IN),"dir");
  config_defaults();size_t n=config_key_count(),grouped=0;CHECK(n==33,"config key count %zu",n);
  for(size_t i=0;i<n;i++){const char *k=config_key_name(i);float v,d;uint32_t vb,db;
   CHECK(config_get_key(k,&v)&&config_get_default_key(k,&d),"%s: no value/default",k);memcpy(&vb,&v,4);memcpy(&db,&d,4);
   CHECK(vb==db,"%s: config_defaults()=%g but config_get_default_key()=%g",k,v,d);
   for(unsigned g=0;g<3;g++)if(in_group(GROUPS[g],k))grouped++;}
  CHECK(grouped==29,"grouped keys covered %zu",grouped);
  CHECK(config_motor_direction()==MOTOR_DIRECTION_PROPS_OUT,"config_defaults motor_direction");}
 /* The shared formatter gives defaults_key the exact `get` text for any value, not only today's defaults. */
 {static const float vals[]={123.456f,.0123456f,5e-05f,1234.56f,0.f};char a[96],b[96];
  for(size_t i=0;i<sizeof vals/sizeof vals[0];i++){setting_format_line(a,sizeof a,"","k",vals[i]);setting_format_line(b,sizeof b,"defaults_key: ","k",vals[i]);
   CHECK(!strncmp(b,"defaults_key: ",14)&&!strcmp(b+14,a),"prefix changes the value text: '%s' vs '%s'",a,b);}
  setting_format_line(a,sizeof a,"","rate_center_roll",123.456f);CHECK(!strcmp(a,"rate_center_roll=123.456\r\n"),"%s",a);
  setting_format_line(a,sizeof a,"","pid_roll_p",.0123456f);CHECK(!strcmp(a,"pid_roll_p=0.0123456\r\n"),"%s",a);}
 if(failures){fprintf(stderr,"%d failure(s)\n",failures);return 1;}
 puts("PASS D1 scoped defaults: pid 11 / rates 9 / filters 9 reset only their keys; props-in, align yaw 90 (active), loop 1000, accel cal, motor_poles, DShot, map, UART survive defaults+save+reload; accel_cal_saved stays yes; exact replies and end counts; refusals byte-identical incl. dirty, in order; config_defaults() == config_get_default_key() for all 33 config keys (29 grouped)");
 return 0;
}
