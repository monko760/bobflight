/* SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "drivers/persist.h"
#include "drivers/gyro.h"
#include "board/board.h"
#include "flight/config.h"
#include "flight/mode_range.h"
#include "flight/arming.h"
#include "drivers/crsf.h"
#include "sched/tasks.h"
#include "bobflight/version.h"
static char output[4096];
static board_t board;
static mode_config_t modes[MODE_COUNT]={{true,1,1751,2100},{true,2,900,2100}
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
 ,{false,2,900,2100},{false,2,900,2100}
#endif
};
static bool saved,dirty,armed,bench,long_cal,long_mode;
static unsigned writes;
static const char *backend="flash",*map="AETR";
static void cli_write_str(const char *s){assert(strlen(output)+strlen(s)<sizeof(output));strcat(output,s);}
const board_t *board_get(void){return &board;}
const mode_config_t *mode_range_get(mode_id_t m){return &modes[m];}
const char *crsf_map(void){return map;}
control_mode_t control_mode_get(void){return long_mode?CONTROL_MODE_HORIZON:CONTROL_MODE_ANGLE;}
const char *control_mode_name(void){return long_mode?"horizon":"angle";}
#if defined(BOBFLIGHT_CONTROL_SOURCE_API)
const char *control_source_name(void){return "manual";}
#endif
arm_state_t arming_state(void){return armed?ARM_ARMED:ARM_DISARMED;}
bool bench_motor_active(void){return bench;}
bool gyro_manual_calibration_active(void){return false;}
const char *persist_backend(void){return backend;}
const char *persist_state(void){return dirty?"dirty":"saved";}
bool persist_dirty(void){return dirty;}
const char *persist_last_error(void){return saved?"none":"write_error";}
uint32_t persist_generation(void){return 7;}
bool persist_save(void){writes++;return saved;}
const char *persist_accel_storage(void){return long_cal?"flash":"not-calibrated";}
/* long_cal: a calibrated FC whose bias/scale print with all 9 %.9g digits (worst-case export). */
void gyro_calibration_info(gyro_calibration_info_t*c){memset(c,0,sizeof(*c));for(unsigned i=0;i<3;i++)c->accel_scale[i]=1.f;
 if(long_cal){static const float b[3]={-0.00123456791f,0.00234567891f,-0.00345678912f},k[3]={1.00123453f,0.998765409f,1.01234567f};
  c->accel_valid=true;for(unsigned i=0;i<3;i++){c->accel_bias[i]=b[i];c->accel_scale[i]=k[i];}}}
#include "drivers/power.h"
const power_config_t *power_config(void){static const power_config_t p={11,0,0,0,3.5f,3.3f,0};
 static const power_config_t lp={12.3456787f,123.456787f,1234.56787f,6,4.12345648f,3.12345648f,12345};return long_cal?&lp:&p;}
unsigned dshot_speed_kbps(void){return 300;}
#include "drivers/storage_cli.h"
#include "sched/loop_rate_setting.h"
int main(void){
 config_init();board.rx_uart=BOARD_GENERATED_RX_UART;strcpy(board.board_id,"dummy");
 cmd_config_export(false);assert(strstr(output,"# kind: diff\r\n"));assert(!strstr(output,"\r\nset "));assert(!strstr(output,"\r\nmode_range "));assert(strstr(output,"# config_end: 1\r\n"));assert(!writes);
 output[0]=0;cmd_config_export(true);assert(strstr(output,"set rate_max_roll 800\r\n"));assert(strstr(output,"mode_range ANGLE 1 2 900 2100\r\n"));assert(strlen(output)<2048);assert(!strstr(output,"\r\nsave\r\n"));assert(!strstr(output,"\r\narm\r\n"));assert(strstr(output,"\r\ncontrol_mode angle\r\n"));assert(!writes);
 assert(config_set_key("rate_max_roll",555.f));modes[1]=(mode_config_t){false,12,1100,1450};map="TAER";
 output[0]=0;cmd_config_export(false);assert(strstr(output,"set rate_max_roll 555\r\n"));assert(strstr(output,"receiver_map TAER\r\n"));assert(strstr(output,"mode_range ANGLE 0 12 1100 1450\r\n"));assert(!strstr(output,"set rate_expo"));assert(!writes);
 output[0]=0;dirty=true;cmd_storage();assert(strstr(output,"storage_api: 1\r\nbackend: flash\r\n"));assert(strstr(output,"dirty: 1\r\n"));assert(strstr(output,"storage_end: 1\r\n"));assert(!writes);
 output[0]=0;saved=false;cmd_save_config();assert(!strcmp(output,"save failed: write_error\r\n"));
 output[0]=0;saved=true;cmd_save_config();assert(!strcmp(output,"saved: flash verified\r\n"));
 output[0]=0;backend="host_sim";cmd_save_config();assert(!strcmp(output,"saved: host_sim verified\r\n"));
 /* Schema 10 worst case with accel calibration (%.9g), every mode row on
  * two-digit AUX12, the longest control mode name, loop_rate_hz 8000 and
  * motor_direction props-in: must fit the Configurator's
  * CONFIG_EXPORT_MAX_BYTES (2048) with at least 64 B headroom. The byte count
  * is printed and asserted (docs/MOTOR-DIRECTION.md records it). */
 {static const struct{const char*k;float v;}big[]={{"rate_max_roll",1234.56787f},{"rate_max_pitch",1234.56787f},{"rate_max_yaw",1234.56787f},
   {"rate_expo",.0123456791f},{"pid_roll_p",1.23456791e-05f},{"pid_roll_i",1.23456791e-05f},{"pid_roll_d",1.23456791e-05f},{"pid_pitch_p",1.23456791e-05f},
   {"pid_pitch_i",1.23456791e-05f},{"pid_pitch_d",1.23456791e-05f},{"pid_yaw_p",1.23456791e-05f},{"pid_yaw_i",1.23456791e-05f},{"pid_yaw_d",1.23456791e-05f},
   {"min_throttle",.0123456791f},{"gyro_lpf_hz",123.456787f},{"dterm_lpf_hz",123.456787f},{"gyro_notch1_cutoff_hz",123.456787f},{"gyro_notch1_hz",234.567886f},
   {"gyro_notch2_cutoff_hz",123.456787f},{"gyro_notch2_hz",234.567886f},{"rpm_filter_harmonics",3},{"rpm_filter_min_hz",200},{"rpm_filter_q_x100",1000},{"motor_poles",36}};
  for(size_t i=0;i<sizeof big/sizeof big[0];i++){if(!config_set_key(big[i].k,big[i].v)){fprintf(stderr,"config_set_key %s refused\n",big[i].k);return 1;}}
  strcpy(board.board_id,"kakute_f7_hdv");
  mode_config_t keep[MODE_COUNT];memcpy(keep,modes,sizeof keep);
  for(unsigned i=0;i<MODE_COUNT;i++)modes[i]=(mode_config_t){true,12,1100,2100};
  if(!loop_rate_setting_set(8000)||!config_set_motor_direction(MOTOR_DIRECTION_PROPS_IN)){fprintf(stderr,"settings refused\n");return 1;}
  long_cal=true;long_mode=true;output[0]=0;cmd_config_export(true);long_cal=false;long_mode=false;
  size_t len=strlen(output);
  printf("calibrated worst-case schema 10 dump: %zu bytes (limit 2560, headroom %zu bytes)\n",len,(size_t)2560u-len);
  if(strstr(output,"config export failed")||len<=1800||len+64>2560){fprintf(stderr,"FAIL: calibrated worst-case dump %zu bytes (need 1800 < len <= 2496: 64 B headroom under 2560, no 'config export failed')\n%s\n",len,output);return 1;}
  assert(strstr(output,"# schema: 11\r\n")&&strstr(output,"set motor_direction props-in\r\nset loop_rate_hz 8000\r\n"));
  assert(strstr(output,"# accel_calibrated: yes\r\n")&&strstr(output,"# accel_bias: -0.0012345")&&strstr(output,"# config_end: 1\r\n"));
  assert(strstr(output,"control_mode horizon\r\n")&&strstr(output,"mode_range ARM 1 12 1100 2100\r\n"));
  /* diff: motor_direction only when it is not the default props-out; dump always. */
  output[0]=0;cmd_config_export(false);assert(strstr(output,"set motor_direction props-in\r\n"));
  assert(config_set_motor_direction(MOTOR_DIRECTION_PROPS_OUT));output[0]=0;cmd_config_export(false);assert(!strstr(output,"set motor_direction"));
  output[0]=0;cmd_config_export(true);assert(strstr(output,"set motor_direction props-out\r\n"));
  memcpy(modes,keep,sizeof keep);loop_rate_setting_defaults();strcpy(board.board_id,"dummy");}
 puts("PASS CLI storage and bounded read-only diff/dump, defaults/deltas, numeric AUX12, explicit verified-save acknowledgments");
}
