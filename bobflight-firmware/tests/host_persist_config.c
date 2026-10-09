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
int main(void){
 power_init();persist_init();assert(!persist_load()&&!saves&&!strcmp(persist_state(),"defaults"));float ignored;
 assert(!config_get_key("rate_type",&ignored)&&!config_set_key("rate_expo",.3f));
 assert(config_get()->rate_center_roll==200&&config_get()->rate_expo_pitch==.3f);
 assert(config_set_key("rate_max_roll",670)&&config_set_key("rate_center_pitch",150)&&config_set_key("rate_expo_yaw",.75f));
 assert(config_set_key("pid_roll_p",.004f)&&config_set_key("pid_yaw_d",.002f));
 assert(config_set_key("gyro_lpf_hz",250)&&config_set_key("dterm_lpf_hz",100));
 assert(config_set_key("align_board_roll",180)&&config_set_key("align_board_yaw",180));config_board_alignment_activate();
 assert(config_set_gyro_notch(1,200,100)&&config_set_key("rpm_filter_harmonics",2)&&config_set_key("motor_poles",14));
 assert(config_set_motor_direction(MOTOR_DIRECTION_PROPS_IN));assert(loop_rate_setting_set(1000));
 assert(crsf_set_map("TAER"));board.rx_uart=2;manual_mode=CONTROL_MODE_ACRO;
 cal.accel_valid=true;for(unsigned i=0;i<3;i++){cal.accel_bias[i]=.01f*(i+1);cal.accel_scale[i]=1;}
 assert(persist_save()&&!persist_dirty());assert(image_len==256&&image_schema==13);uint8_t good[256];memcpy(good,image,256);
 assert(getfloat(image)==670&&getfloat(image+16)==150&&getfloat(image+32)==.75f&&getfloat(image+68)==.002f);
 assert(get32(image+72)==2&&image[76]==1&&get32(image+192)==1000&&get32(image+228)==1&&getfloat(image+232)==180);
 persist_init();memset(&cal,0,sizeof cal);manual_mode=CONTROL_MODE_ANGLE;board.rx_uart=6;
 assert(persist_load());config_board_alignment_activate();assert(!persist_dirty());
 assert(config_get()->rate_max_roll==670&&config_get()->rate_center_pitch==150&&config_get()->rate_expo_yaw==.75f&&config_get()->pid_yaw_d==.002f);
 assert(config_get()->gyro_lpf_hz==250&&config_get()->gyro_notch1_hz==200&&config_get()->rpm_filter_harmonics==2);
 assert(manual_mode==CONTROL_MODE_ACRO&&board.rx_uart==2&&!strcmp(crsf_map(),"TAER")&&cal.accel_valid&&cal.accel_bias[2]==.03f);
 assert(!strcmp(persist_accel_storage(),"host-sim"));
 /* Every current key must survive, with validation before state mutation. */
 for(unsigned n=0;n<18;n++){memcpy(image,good,256);putfloat(image+n*4,NAN);assert(config_set_key("rate_max_roll",999));assert(!persist_load());assert(config_get()->rate_max_roll==999);}
 static const unsigned corrupt[]={76,77,78,79,80,81,86,112,113,116,180,181,228,244};
 for(unsigned n=0;n<sizeof corrupt/sizeof corrupt[0];n++){memcpy(image,good,256);image[corrupt[n]]=255;assert(!persist_load());}
 memcpy(image,good,256);assert(persist_load());config_board_alignment_activate();
 assert(config_set_key("align_board_roll",0));assert(persist_save());assert(image[112]==0);for(unsigned i=113;i<144;i++)assert(image[i]==0);for(unsigned i=244;i<256;i++)assert(image[i]==0);
 for(unsigned schema=1;schema<=14;schema++)if(schema!=13){image_schema=schema;unsigned count=saves;persist_init();assert(!persist_load()&&!strcmp(persist_last_error(),"fresh_install_required"));assert(saves==count);assert(!persist_save());}
 image_schema=13;memcpy(image,good,256);assert(persist_load());config_board_alignment_activate();
 unsigned count=saves;armed=true;assert(!persist_save()&&!persist_load());armed=false;bench=true;assert(!persist_save());bench=false;calibrating=true;assert(!persist_save());calibrating=false;assert(saves==count);
 write_failure=true;assert(!persist_save()&&!strcmp(persist_last_error(),"storage_io"));write_failure=false;read_failure=true;assert(!persist_load());read_failure=false;
 puts("PASS fresh Actual configuration: compact payload, complete current roundtrip, calibration/mount binding, invalid fields, old-schema rejection, no implicit saves, armed/bench/calibration guards");
 return 0;
}
