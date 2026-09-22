/* SPDX-License-Identifier: Apache-2.0 */
#define main original_sd_transport_tests
#include "host_sd_spi.c"
#undef main
#include "flight/arming.h"
#include "sched/tasks.h"
#include "sched/scheduler.h"
#include "drivers/gyro.h"
#include "drivers/dshot.h"
#include "flight/config.h"
#include "hal/hal.h"
static bool armed,bench,cal,usb=true,dirty,bl_pending;
static uint64_t now;
static unsigned binds,cancels;
static char output[4096];
static void cli_write_str(const char *s){assert(strlen(output)+strlen(s)<sizeof output);strcat(output,s);}
arm_state_t arming_state(void){return armed?ARM_ARMED:ARM_DISARMED;}
bool bench_motor_active(void){return bench;}
bool gyro_manual_calibration_active(void){return cal;}
bool hal_usb_cdc_connected(void){return usb;}
uint64_t hal_micros(void){return now;}
bool persist_dirty(void){return dirty;}
unsigned dshot_speed_kbps(void){return 300;}
const scheduler_stats_t *scheduler_stats(void){static scheduler_stats_t s={.gyro_hz=1000,.pid_process_denom=1};return &s;}
bool sd_spi_hw_bind(sd_spi_io_t *io){binds++;*io=create_mock_io();return true;}
void sd_spi_hw_cancel(void){cancels++;g_mock.cs_asserted=false;g_mock.io_pending=false;}
#define BOBFLIGHT_MCU 1
#define BOBFLIGHT_VERSION_STRING "0.2.0-cli-test"
#include "drivers/sd_cli.h"
#include "drivers/blackbox_cli.h"
int main(void){
 config_init();reset_mock_card(MOCK_CARD_SDHC_64GB);
 for(unsigned kind=0;kind<6;kind++){
  armed=kind==0;bench=kind==1;cal=kind==2;usb=kind!=3;bl_pending=kind==4;dirty=kind==5;output[0]=0;
  assert(cmd_blackbox("blackbox start")&&strstr(output,"blackbox refused")&&strstr(output,"blackbox_end: 1"));assert(!binds&&!g_mock.write_commands);
 }
 armed=bench=cal=dirty=bl_pending=false;usb=true;output[0]=0;
 assert(!cmd_blackbox("blackbox format")&&!cmd_blackbox("blackbox delete"));assert(!binds);
 assert(cmd_blackbox("blackbox start")&&binds==1&&blackbox_cli_busy());assert(strstr(output,"initializing"));
 output[0]=0;assert(cmd_blackbox("blackbox start")&&binds==1&&strstr(output,"refused"));
 const char *blocked[]={"sd probe","sd cancel","sd status"};
 for(unsigned i=0;i<3;i++){unsigned before=cancels;output[0]=0;assert(cmd_sd(blocked[i])&&strstr(output,"recording owns the card")&&strstr(output,"sd_end: 1"));assert(cancels==before);}
 output[0]=0;assert(blackbox_cli_filter("set pid_roll_p = 1"));assert(blackbox_cli_filter("bl"));assert(!blackbox_cli_filter("disarm")&&!blackbox_cli_filter("bench_stop"));
 output[0]=0;assert(blackbox_cli_filter("mode_range 0 1 1 1751 2100"));assert(strstr(output,"modes_end: 1"));
 usb=false;now+=10;blackbox_cli_poll();assert(blackbox_cli_busy()); /* Disconnect does not cancel the recorder. */
 output[0]=0;assert(cmd_blackbox("blackbox stop"));
 for(unsigned i=0;i<10000&&blackbox_cli_busy();i++){now+=10;blackbox_cli_poll();}
 assert(!blackbox_cli_busy()&&bbl.phase==BBS_DONE&&!g_mock.write_commands);assert(!strcmp(bbl.reason,"stopped-before-file-creation"));
 puts("PASS onboard CLI: arm/motor/calibration/USB/save/bootloader start guards, no duplicate start, exclusive card ownership, framed maintenance refusals, disconnect continuity and pre-file stop with zero writes");
}
