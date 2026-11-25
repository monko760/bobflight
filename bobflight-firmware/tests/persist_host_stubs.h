/* SPDX-License-Identifier: Apache-2.0
 * Host stubs persist.c needs besides the store (board, arming, receiver, gyro,
 * power ADC, DShot). Shared by the schema 14 test and the schema 13 fixture
 * generator so both encode the same aircraft. Include before persist.c. */
#ifndef BOBFLIGHT_PERSIST_HOST_STUBS_H
#define BOBFLIGHT_PERSIST_HOST_STUBS_H
#include <string.h>
#include "drivers/gyro.h"
#include "drivers/sensor_calibration.h"
#include "board/board.h"
#include "flight/arming.h"
#include "sched/tasks.h"
#include "flight/mode_range.h"
#include "sched/loop_rate_setting.h"
#include "flight/config.h"
#include "drivers/power.h"
#include "hal/hal.h"
static board_t board={.board_id="kakute_f7_hdv",.rx_uart=6};
static bool armed,bench,calibrating;
static unsigned rx_resets,freshness_resets;
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
bool rx_frame_fresh(void){return false;}
static float restored_rc[16];
const float *rx_channels(void){return restored_rc;}
static gyro_calibration_info_t cal;
void gyro_calibration_info(gyro_calibration_info_t *out){*out=cal;}
uint32_t gyro_accel_calibration_binding(void){return 0x01006810u;}
bool gyro_accel_restore_valid(const float b[3],const float v[3],uint32_t binding){return binding==gyro_accel_calibration_binding()&&sc_accel_coefficients_valid(b,v);}
void gyro_restore_accel_calibration(const float b[3],const float v[3],bool valid){memcpy(cal.accel_bias,b,12);memcpy(cal.accel_scale,v,12);cal.accel_valid=valid;}
void hal_power_adc_init(hal_pin_t a,hal_pin_t b){(void)a;(void)b;}
bool hal_power_adc_poll(uint16_t*a,uint16_t*b){(void)a;(void)b;return false;}
uint32_t hal_millis(void){return 0;}
static unsigned speed=300;
unsigned dshot_speed_kbps(void){return speed;}
bool dshot_set_speed_kbps(unsigned v){if(v!=300&&v!=600)return false;speed=v;return true;}
/* In-memory flash: two 256 KiB slots (the host_sim geometry in hal_host.c). */
static uint8_t flash[524288];
static bool flash_read_fail;
static int flash_write_budget=-1; /* bytes left before a simulated power cut; -1 = unlimited */
static unsigned flash_erases;
bool hal_flash_supported(void){return true;}
bool hal_flash_geometry(hal_flash_geometry_t*g){*g=(hal_flash_geometry_t){{0,262144},{262144,262144},1};return true;}
const char *hal_flash_backend(void){return "host_sim";}
bool hal_flash_read(uint32_t off,void *dst,size_t n){if(flash_read_fail||off>sizeof(flash)||n>sizeof(flash)-off)return false;memcpy(dst,flash+off,n);return true;}
bool hal_flash_erase_slot(unsigned slot){if(slot>1)return false;flash_erases++;memset(flash+slot*262144u,255,262144u);return true;}
bool hal_flash_write(uint32_t off,const void *src,size_t n){if(off>sizeof(flash)||n>sizeof(flash)-off)return false;const uint8_t*p=src;for(size_t i=0;i<n;i++){if(flash_write_budget==0)return false;if(flash_write_budget>0)flash_write_budget--;flash[off+i]&=p[i];}return true;}

/* The one non-default aircraft both the fixture generator and the test use:
 * every schema 13 field differs from its default. Valid on schema 13 and 14. */
static bool configure_reference_aircraft(void){
 static const struct{const char*k;float v;}kv[]={
  {"rate_max_roll",670},{"rate_max_pitch",720},{"rate_max_yaw",540},
  {"rate_center_roll",150},{"rate_center_pitch",160},{"rate_center_yaw",170},
  {"rate_expo_roll",.75f},{"rate_expo_pitch",.5f},{"rate_expo_yaw",.25f},
  {"pid_roll_p",.004f},{"pid_roll_i",.003f},{"pid_roll_d",.0001f},
  {"pid_pitch_p",.005f},{"pid_pitch_i",.0035f},{"pid_pitch_d",.00012f},
  {"pid_yaw_p",.006f},{"pid_yaw_i",.002f},{"pid_yaw_d",.002f},
  {"min_throttle",.07f},{"airmode",1},{"gyro_lpf_hz",250},{"dterm_lpf_hz",100},
  {"rpm_filter_harmonics",2},{"rpm_filter_min_hz",120},{"rpm_filter_q_x100",600},{"motor_poles",12},
  {"align_board_roll",180},{"align_board_pitch",0},{"align_board_yaw",90}};
 for(size_t i=0;i<sizeof kv/sizeof kv[0];i++)if(!config_set_key(kv[i].k,kv[i].v))return false;
 if(!config_set_gyro_notch(1,200,100)||!config_set_gyro_notch(2,300,150))return false;
 config_board_alignment_activate();
 if(!config_set_motor_direction(MOTOR_DIRECTION_PROPS_IN)||!loop_rate_setting_set(1000))return false;
 if(!crsf_set_map("TAER")||!board_select_rx_uart(2))return false;
 manual_mode=CONTROL_MODE_ACRO;
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 aux_source=true;
#endif
 if(!mode_range_set(MODE_ARM,true,5,1600,2100)||!mode_range_set(MODE_ANGLE,false,3,900,1300)||
    !mode_range_set(MODE_ACRO,true,4,1300,1700)||!mode_range_set(MODE_HORIZON,true,6,1700,2100))return false;
 const power_config_t pc={12.5f,40.f,100.f,4,3.6f,3.4f,1500};
 if(!power_configure(&pc)||!dshot_set_speed_kbps(600))return false;
 cal.accel_valid=true;for(unsigned i=0;i<3;i++){cal.accel_bias[i]=.01f*(float)(i+1);cal.accel_scale[i]=1.f+.01f*(float)i;}
 return true;
}
#endif
