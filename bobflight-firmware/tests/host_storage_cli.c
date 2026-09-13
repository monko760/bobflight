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
static bool saved,dirty,armed,bench;
static unsigned writes;
static const char *backend="flash",*map="AETR";
static void cli_write_str(const char *s){assert(strlen(output)+strlen(s)<sizeof(output));strcat(output,s);}
const board_t *board_get(void){return &board;}
const mode_config_t *mode_range_get(mode_id_t m){return &modes[m];}
const char *crsf_map(void){return map;}
control_mode_t control_mode_get(void){return CONTROL_MODE_ANGLE;}
const char *control_mode_name(void){return "angle";}
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
const char *persist_accel_storage(void){return "not-calibrated";}
void gyro_calibration_info(gyro_calibration_info_t*c){memset(c,0,sizeof(*c));for(unsigned i=0;i<3;i++)c->accel_scale[i]=1.f;}
#include "drivers/storage_cli.h"
int main(void){
 config_init();board.rx_uart=BOARD_GENERATED_RX_UART;strcpy(board.board_id,"dummy");
 cmd_config_export(false);assert(strstr(output,"# kind: diff\r\n"));assert(!strstr(output,"\r\nset "));assert(!strstr(output,"\r\nmode_range "));assert(strstr(output,"# config_end: 1\r\n"));assert(!writes);
 output[0]=0;cmd_config_export(true);assert(strstr(output,"set rate_max_roll 800\r\n"));assert(strstr(output,"mode_range ANGLE 1 2 900 2100\r\n"));assert(strlen(output)<1800);assert(!strstr(output,"\r\nsave\r\n"));assert(!strstr(output,"\r\narm\r\n"));assert(strstr(output,"\r\ncontrol_mode angle\r\n"));assert(!writes);
 assert(config_set_key("rate_max_roll",555.f));modes[1]=(mode_config_t){false,12,1100,1450};map="TAER";
 output[0]=0;cmd_config_export(false);assert(strstr(output,"set rate_max_roll 555\r\n"));assert(strstr(output,"receiver_map TAER\r\n"));assert(strstr(output,"mode_range ANGLE 0 12 1100 1450\r\n"));assert(!strstr(output,"set rate_expo"));assert(!writes);
 output[0]=0;dirty=true;cmd_storage();assert(strstr(output,"storage_api: 1\r\nbackend: flash\r\n"));assert(strstr(output,"dirty: 1\r\n"));assert(strstr(output,"storage_end: 1\r\n"));assert(!writes);
 output[0]=0;saved=false;cmd_save_config();assert(!strcmp(output,"save failed: write_error\r\n"));
 output[0]=0;saved=true;cmd_save_config();assert(!strcmp(output,"saved: flash verified\r\n"));
 output[0]=0;backend="host_sim";cmd_save_config();assert(!strcmp(output,"saved: host_sim verified\r\n"));
 puts("PASS CLI storage and bounded read-only diff/dump, defaults/deltas, numeric AUX12, explicit verified-save acknowledgments");
}
