/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#define main original_sd_tests_main
#include "host_sd_spi.c"
#undef main
#include "flight/arming.h"
#include "sched/tasks.h"
#include "drivers/gyro.h"
#include "hal/hal.h"
static bool armed,bench,cal,usb=true,bl_pending;
static uint64_t now;
static unsigned binds,cancels;
static char output[4096];
static void cli_write_str(const char *s){assert(strlen(output)+strlen(s)<sizeof output);strcat(output,s);}
arm_state_t arming_state(void){return armed?ARM_ARMED:ARM_DISARMED;}
bool bench_motor_active(void){return bench;}
bool gyro_manual_calibration_active(void){return cal;}
bool hal_usb_cdc_connected(void){return usb;}
uint64_t hal_micros(void){return now;}
bool sd_spi_hw_bind(sd_spi_io_t *io){binds++;*io=create_mock_io();return true;}
void sd_spi_hw_cancel(void){cancels++;g_mock.cs_asserted=false;g_mock.io_pending=false;}
#define BOBFLIGHT_SD_CLI_TEST 1
#include "drivers/sd_cli.h"
int main(void){
 reset_mock_card(MOCK_CARD_SDHC_64GB);
 for(unsigned kind=0;kind<5;kind++){
  armed=kind==0;bench=kind==1;cal=kind==2;usb=kind!=3;bl_pending=kind==4;output[0]=0;
  assert(cmd_sd("sd probe")&&strstr(output,"sd refused")&&strstr(output,"sd_end: 1"));assert(!binds);
 }
 armed=bench=cal=bl_pending=false;usb=true;output[0]=0;
 assert(!cmd_sd("sd format")&&!cmd_sd("sd write 1"));assert(!binds);
 assert(cmd_sd("sd probe")&&binds==1&&sd_probe_busy(&cli_sd));assert(strstr(output,"sd_write_enabled: no"));
 output[0]=0;assert(cmd_sd("sd probe")&&binds==1&&strstr(output,"sd refused"));
 armed=true;sd_cli_poll();assert(armed&&cli_sd.phase==SD_PROBE_CANCELLED&&!g_mock.cs_asserted);
 armed=false;output[0]=0;assert(cmd_sd("sd probe")&&binds==2);
 for(unsigned i=0;i<10000&&sd_probe_busy(&cli_sd);i++){now+=10;sd_cli_poll();}
 assert(cli_sd.phase==SD_PROBE_ERROR);assert(!g_mock.write_commands);
 output[0]=0;assert(cmd_sd("sd status"));assert(strstr(output,"sd_capacity_bytes: 64000360448"));assert(strstr(output,"sd_filesystem_validated: no")&&strstr(output,"sd_end: 1"));
 output[0]=0;assert(cmd_sd("sd probe"));usb=false;sd_cli_poll();assert(cli_sd.phase==SD_PROBE_CANCELLED);assert(cmd_sd("sd cancel"));assert(cancels>0&&!g_mock.write_commands);
 puts("PASS SD CLI: armed/motor/calibration/USB/bootloader guards, no duplicate start, status framing, cancellation/retry, no SD writes");
}
