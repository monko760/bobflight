/* SPDX-License-Identifier: Apache-2.0 */
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
static board_t board={.board_id="kakute_f7_hdv",.rx_uart=6};
static bool armed,bench,calibrating,supported=true,exists,write_failure,read_failure;
static unsigned saves,rx_resets,freshness_resets,generation;
static uint8_t image[184];static size_t image_len;static uint32_t image_board;
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
config_store_result_t config_store_load(uint32_t id,void *p,size_t n){if(!supported)return CONFIG_STORE_UNSUPPORTED;if(read_failure)return CONFIG_STORE_IO_ERROR;if(!exists)return CONFIG_STORE_EMPTY;if(n!=image_len||id!=image_board)return CONFIG_STORE_INVALID;memcpy(p,image,n);return CONFIG_STORE_OK;}
config_store_result_t config_store_save(uint32_t id,const void *p,size_t n){saves++;if(!supported)return CONFIG_STORE_UNSUPPORTED;if(write_failure)return CONFIG_STORE_IO_ERROR;if(!exists||n!=image_len||memcmp(p,image,n))generation++;memcpy(image,p,n);image_len=n;image_board=id;exists=true;return CONFIG_STORE_OK;}
static gyro_calibration_info_t cal;
void gyro_calibration_info(gyro_calibration_info_t *out){*out=cal;}
uint32_t gyro_accel_calibration_binding(void){return 0x01006810u;}
bool gyro_accel_restore_valid(const float b[3],const float v[3],uint32_t binding){return binding==gyro_accel_calibration_binding()&&sc_accel_coefficients_valid(b,v);}
void gyro_restore_accel_calibration(const float b[3],const float v[3],bool valid){memcpy(cal.accel_bias,b,12);memcpy(cal.accel_scale,v,12);cal.accel_valid=valid;}
uint32_t config_store_loaded_schema(void){return image_len==96?1:image_len==128?2:image_len==160?3:image_len==176?4:5;}
config_store_result_t config_store_load_v2(uint32_t id,void*p,size_t n){
 if(image_len==96&&n==128&&exists&&!read_failure&&supported&&id==image_board){memset(p,0,n);memcpy(p,image,96);return CONFIG_STORE_OK;}
 return config_store_load(id,p,n);
}
config_store_result_t config_store_save_v2(uint32_t id,const void*p,size_t n){return config_store_save(id,p,n);}
#include "drivers/power.h"
#include "hal/hal.h"
void hal_power_adc_init(hal_pin_t a,hal_pin_t b){(void)a;(void)b;}
bool hal_power_adc_poll(uint16_t *a,uint16_t *b){(void)a;(void)b;return false;}
uint32_t hal_millis(void){return 0;}
static unsigned speed=300;static bool speed_failure;
unsigned dshot_speed_kbps(void){return speed;}
bool dshot_set_speed_kbps(unsigned v){if(speed_failure)return false;speed=v;return true;}
config_store_result_t config_store_load_v3(uint32_t id,void*p,size_t n){
 if((image_len==96||image_len==128)&&n==160&&exists&&!read_failure&&supported&&id==image_board){memset(p,0,n);memcpy(p,image,image_len);return CONFIG_STORE_OK;}
 return config_store_load(id,p,n);
}
config_store_result_t config_store_save_v3(uint32_t id,const void*p,size_t n){return config_store_save(id,p,n);}
config_store_result_t config_store_load_v4(uint32_t id,void*p,size_t n){
 if((image_len==96||image_len==128||image_len==160)&&n==176&&exists&&!read_failure&&supported&&id==image_board){memset(p,0,n);memcpy(p,image,image_len);return CONFIG_STORE_OK;}
 return config_store_load(id,p,n);
}
config_store_result_t config_store_save_v4(uint32_t id,const void*p,size_t n){return config_store_save(id,p,n);}
config_store_result_t config_store_load_v5(uint32_t id,void*p,size_t n){
 if((image_len==96||image_len==128||image_len==160||image_len==176)&&n==184&&exists&&!read_failure&&supported&&id==image_board){memset(p,0,n);memcpy(p,image,image_len);return CONFIG_STORE_OK;}
 return config_store_load(id,p,n);
}
config_store_result_t config_store_save_v5(uint32_t id,const void*p,size_t n){return config_store_save(id,p,n);}
/* Include the codec to validate the on-wire byte format, not just happy-path APIs. */
#include "../src/drivers/persist.c"
int main(void){
 power_init();persist_init();assert(!persist_load());assert(!strcmp(persist_state(),"defaults"));assert(persist_dirty());
 assert(config_set_key("rate_max_roll",777));assert(board_select_rx_uart(1));assert(crsf_set_map("TAER"));assert(mode_range_set(MODE_ANGLE,false,12,1100,1450));
 assert(mode_range_set(MODE_ARM,true,11,1200,1500));
 assert(control_mode_set(CONTROL_MODE_ACRO));
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 assert(mode_range_set(MODE_ACRO,true,5,1300,1600));assert(mode_range_set(MODE_HORIZON,true,6,1600,1900));assert(control_source_set(true));
#endif
 assert(persist_save());assert(!persist_dirty());assert(!strcmp(persist_state(),"saved"));assert(image_len==PAYLOAD_BYTES);assert(image[48]==1&&image[52]==1&&image[64]==0&&image[65]==12);unsigned seq=generation;
 assert(persist_save());assert(generation==seq);
 board.rx_uart=6;manual_mode=CONTROL_MODE_ANGLE;
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 aux_source=false;
#endif
 persist_init();assert(!strcmp(map,"AETR"));assert(mode_range_get(MODE_ANGLE)->aux_channel==2);assert(persist_load());
 assert(mode_range_get(MODE_ARM)->aux_channel==11);
 assert(mode_range_get(MODE_ARM)->min_us==1200 && mode_range_get(MODE_ARM)->max_us==1500);
 restored_rc[14]=-.5f;restored_rc[4]=1;bool arm_request=false;
 assert(!mode_range_arm_input(&arm_request)); // Restore alone cannot fabricate a fresh switch.
 restored_fresh=true;assert(mode_range_arm_input(&arm_request)&&arm_request); // Restored AUX11, not AUX1.
 restored_rc[14]=1;assert(mode_range_arm_input(&arm_request)&&!arm_request);restored_fresh=false;
 float v;assert(config_get_key("rate_max_roll",&v)&&v==777);assert(board.rx_uart==1&&!strcmp(map,"TAER"));assert(mode_range_get(MODE_ANGLE)->aux_channel==12);assert(!persist_dirty());assert(rx_resets==1&&freshness_resets==1);assert(manual_mode==CONTROL_MODE_ACRO);
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 assert(aux_source);assert(mode_range_get(MODE_ACRO)->aux_channel==5);assert(mode_range_get(MODE_HORIZON)->aux_channel==6);
#endif
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 /* Cold-reset all volatile mode selections, then restore each manual mode/source pair. */
 for(unsigned mode=0;mode<3;mode++)for(unsigned source=0;source<2;source++){
  assert(control_mode_set((control_mode_t)mode));assert(control_source_set(source!=0));assert(persist_save());
  manual_mode=CONTROL_MODE_ANGLE;aux_source=false;persist_init();assert(persist_load());
  assert((unsigned)manual_mode==mode);assert(aux_source==(source!=0));
  assert(mode_range_get(MODE_ANGLE)->aux_channel==12);assert(mode_range_get(MODE_ACRO)->aux_channel==5);assert(mode_range_get(MODE_HORIZON)->aux_channel==6);
 }
#endif
 unsigned before=saves;armed=true;assert(!persist_save());armed=false;bench=true;assert(!persist_save());bench=false;calibrating=true;assert(!persist_save());calibrating=false;assert(saves==before);
 assert(config_set_key("rate_max_roll",666));write_failure=true;assert(!persist_save());assert(persist_dirty());write_failure=false;assert(persist_load());assert(config_get_key("rate_max_roll",&v)&&v==777);
 uint8_t good[PAYLOAD_BYTES];memcpy(good,image,PAYLOAD_BYTES);
 const unsigned bad_offsets[]={0,3,48,52,53,54,55,64,65,66,67,68,69,70,71};
 for(unsigned i=0;i<sizeof(bad_offsets)/sizeof(bad_offsets[0]);i++){
  memcpy(image,good,PAYLOAD_BYTES);unsigned o=bad_offsets[i];image[o]=255;
  /* Single mantissa bit changes may be valid; explicitly force NaN for float cases. */
  if(o<48){image[0]=0;image[1]=0;image[2]=0xc0;image[3]=0x7f;}
  if(o==66||o==67){image[66]=0;image[67]=0;}if(o==68||o==69){image[68]=0xff;image[69]=0xff;}
  assert(config_set_key("rate_max_roll",444));assert(!persist_load());assert(config_get_key("rate_max_roll",&v)&&v==444);assert(board.rx_uart==1);assert(mode_range_get(MODE_ANGLE)->aux_channel==12);
 }
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 /* Upgrade a two-row schema-1 payload while preserving old settings and new defaults. */
 memcpy(image,good,PAYLOAD_BYTES);image[53]=2;image[54]=0;image[55]=1;memset(image+72,0,128-72);
 persist_init();assert(persist_load());assert(mode_range_get(MODE_ANGLE)->aux_channel==12);assert(!mode_range_get(MODE_ACRO)->enabled);assert(!mode_range_get(MODE_HORIZON)->enabled);assert(persist_dirty());
#endif
 memcpy(image,good,PAYLOAD_BYTES);read_failure=true;assert(!persist_load());read_failure=false;assert(persist_load());supported=false;assert(!persist_save());assert(!strcmp(persist_state(),"unsupported"));

 supported=true;memcpy(image,good,PAYLOAD_BYTES);image_len=PAYLOAD_BYTES;assert(persist_load());
 sensor_calibration_t solved;sc_init(&solved);solved.mode=SC_ACCEL_WAIT;solved.faces=63;
 for(unsigned face=0;face<6;face++){
  solved.face_mean[face][2]=-.2f;
  solved.face_mean[face][face/2]+=(face&1)?-1.f:1.f;
 }
 assert(sc_apply_accel(&solved));cal.accel_valid=solved.accel_valid;
 memcpy(cal.accel_bias,solved.accel_bias,12);memcpy(cal.accel_scale,solved.accel_scale,12);
 assert(persist_dirty()&&!strcmp(persist_accel_storage(),"unsaved"));assert(persist_save());
 assert(image[96]==1&&!persist_dirty()&&!strcmp(persist_accel_storage(),"host-sim"));
 memcpy(good,image,PAYLOAD_BYTES);memset(&cal,0,sizeof(cal));persist_init();assert(persist_load());
 assert(cal.accel_valid&&!memcmp(cal.accel_bias,solved.accel_bias,12)&&!memcmp(cal.accel_scale,solved.accel_scale,12));
 assert(!cal.candidate_valid&&cal.faces==0&&cal.gyro_bias[0]==0);
 cal.candidate_valid=true;cal.candidate_bias[0]=NAN;cal.gyro_bias[0]=42;
 assert(!persist_dirty());calibrating=true;before=saves;assert(!persist_save()&&saves==before);calibrating=false;
 cal.accel_bias[2]-=.01f;write_failure=true;assert(!persist_save());assert(!strcmp(persist_accel_storage(),"unsaved"));write_failure=false;
 assert(persist_load());assert(!memcmp(cal.accel_bias,solved.accel_bias,12));
 const unsigned bad_cal[]={96,97,100,104,116};
 for(unsigned i=0;i<sizeof(bad_cal)/sizeof(bad_cal[0]);i++){
  memcpy(image,good,PAYLOAD_BYTES);unsigned o=bad_cal[i];
  if(o==104||o==116)put32(image+o,0x7fc00000u);else image[o]^=2;
  assert(config_set_key("rate_max_roll",444));float original=cal.accel_bias[2];
  assert(!persist_load());assert(config_get_key("rate_max_roll",&v)&&v==444&&cal.accel_bias[2]==original);
 }
 memcpy(image,good,PAYLOAD_BYTES);for(unsigned i=0;i<3;i++){float b=.25f;uint32_t bits;memcpy(&bits,&b,4);put32(image+104+i*4,bits);}assert(!persist_load());
 memcpy(image,good,PAYLOAD_BYTES);assert(persist_load());
 /* A valid schema1 record migrates ALL existing settings, but never invents calibration. */
 image_len=128;memset(&cal,0,sizeof(cal));persist_init();assert(persist_load());assert(cal.accel_valid&&cal.accel_bias[2]==solved.accel_bias[2]&&persist_dirty());assert(persist_save());
 image_len=96;persist_init();assert(persist_load());assert(!cal.accel_valid);assert(persist_dirty());
 assert(config_get_key("rate_max_roll",&v)&&v==777);assert(!strcmp(map,"TAER"));
 assert(persist_save());assert(image_len==PAYLOAD_BYTES&&!image[96]&&!persist_dirty());
 /* All power fields + DShot survive cold resets; malformed values mutate neither. */
 const power_config_t desired={12.25f,27.5f,100.f,6,3.6f,3.2f,1500};
 assert(power_configure(&desired));speed=600;assert(persist_dirty());assert(persist_save());
 power_init();speed=300;persist_init();assert(persist_load());
 assert(power_config()->voltage_scale==12.25f&&power_config()->current_mv_per_amp==27.5f&&power_config()->current_offset_mv==100.f);
 assert(power_config()->cells==6&&power_config()->warning_cell_v==3.6f&&power_config()->critical_cell_v==3.2f&&power_config()->capacity_mah==1500&&speed==600);
 assert(!power_state()->valid&&!power_state()->consumption_valid&&!persist_dirty());
 memcpy(good,image,PAYLOAD_BYTES);
 for(unsigned offset=128;offset<160;offset+=4){memcpy(image,good,PAYLOAD_BYTES);put32(image+offset,0x7fc00000u);power_init();speed=300;assert(!persist_load());assert(power_config()->voltage_scale==11.f&&speed==300);}
 memcpy(image,good,PAYLOAD_BYTES);speed_failure=true;assert(!persist_load());assert(power_config()->voltage_scale==11.f);speed_failure=false;assert(persist_load());
 image_len=128;power_init();speed=300;persist_init();assert(persist_load());assert(power_config()->voltage_scale==11.f&&speed==300&&persist_dirty());assert(persist_save());
 /* Schema4 payload migrates LPF defaults 320/53 and stays dirty until Save. */
 {
  assert(persist_save());
  uint8_t schema4[176];memcpy(schema4,image,176);image_len=176;memcpy(image,schema4,176);
  float g=0,d=0;assert(config_set_key("gyro_lpf_hz",999.f));assert(config_set_key("dterm_lpf_hz",999.f));
  persist_init();assert(persist_load());
  assert(config_get_key("gyro_lpf_hz",&g)&&g==320.f);assert(config_get_key("dterm_lpf_hz",&d)&&d==53.f);
  assert(persist_dirty());assert(persist_save());assert(image_len==PAYLOAD_BYTES&&!persist_dirty());
  assert(config_set_key("gyro_lpf_hz",400.f));assert(config_set_key("dterm_lpf_hz",0.f));assert(persist_save());
  persist_init();assert(persist_load());assert(config_get_key("gyro_lpf_hz",&g)&&g==400.f);assert(config_get_key("dterm_lpf_hz",&d)&&d==0.f);
  assert(!config_set_key("gyro_lpf_hz",5.f));assert(!config_set_key("dterm_lpf_hz",1001.f));
 }

 supported=false;cal.accel_valid=true;before=saves;assert(!persist_save());assert(!strcmp(persist_accel_storage(),"ram-only"));
 puts("PASS actual six-face solver -> codec -> cold restore, candidate/gyro exclusion, atomic malformed-cal refusal, dirty/save/error state, old-settings migration and unsupported target");
 puts("PASS codec offsets, validated atomic restore, repeated boot-init roundtrip, dirty tracking, guards, failed writes/readback, malformed fields and scope");
}
