/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_SD_CLI_H
#define BOBFLIGHT_SD_CLI_H
#if defined(BOBFLIGHT_MCU)
static bool blackbox_cli_busy(void);
#endif
#if defined(BOBFLIGHT_MCU) || defined(BOBFLIGHT_SD_CLI_TEST)
#include "drivers/sd_probe.h"
#include "hal/stm32f7/sd_spi_hw.h"
static sd_probe_t cli_sd;
static bool sd_cli_guard(void){return arming_state()!=ARM_ARMED&&!bench_motor_active()&&!gyro_manual_calibration_active()&&hal_usb_cdc_connected()&&!bl_pending;}
static void sd_cli_poll(void){
 if(!sd_probe_busy(&cli_sd))return;
 if(!sd_cli_guard()){sd_probe_cancel(&cli_sd);sd_spi_hw_cancel();return;}
 sd_probe_poll(&cli_sd,hal_micros());
 if(cli_sd.phase==SD_PROBE_ERROR)sd_spi_hw_cancel();
}
static void sd_cli_status(void){
 static const char *states[]={"idle","initializing","reading-mbr","reading-boot-sector","done","error","cancelled"};
 char out[512];
 snprintf(out,sizeof out,"sd_api: 1\r\nsd_state: %s\r\nsd_detail: %s\r\nsd_capacity_bytes: %llu\r\nsd_sectors: %llu\r\nsd_partition_lba: %lu\r\nsd_filesystem_hint: %s\r\nsd_cluster_bytes: %lu\r\nsd_volume_flags: %u\r\nsd_io_error: %u\r\nsd_write_enabled: no\r\nsd_filesystem_validated: no\r\nsd_end: 1\r\n",
 states[cli_sd.phase],cli_sd.detail?cli_sd.detail:"not-probed",(unsigned long long)cli_sd.card.card_info.capacity_bytes,(unsigned long long)cli_sd.card.card_info.capacity_sectors,(unsigned long)cli_sd.partition_lba,cli_sd.filesystem?cli_sd.filesystem:"unknown",(unsigned long)cli_sd.cluster_bytes,cli_sd.volume_flags,(unsigned)cli_sd.card.last_error);
 cli_write_str(out);
}
static bool cmd_sd(const char *line){
 if(strcmp(line,"sd probe")&&strcmp(line,"sd status")&&strcmp(line,"sd cancel"))return false;
#if defined(BOBFLIGHT_MCU)
 if(blackbox_cli_busy()){cli_write_str("sd unavailable: Blackbox recording owns the card; stop and wait for done\r\nsd_end: 1\r\n");return true;}
#endif
 if(!strcmp(line,"sd cancel")){sd_probe_cancel(&cli_sd);sd_spi_hw_cancel();}
 if(!strcmp(line,"sd probe")){
  if(!sd_cli_guard()||sd_probe_busy(&cli_sd)){cli_write_str("sd refused: disarm, stop motor tests/calibration, connect USB, and wait or cancel the current probe\r\nsd_end: 1\r\n");return true;}
  sd_spi_io_t io;sd_spi_hw_cancel();
  if(!sd_spi_hw_bind(&io)){cli_write_str("sd unavailable: unsupported board, clock or pin configuration\r\nsd_end: 1\r\n");return true;}
  if(!sd_probe_start(&cli_sd,&io,hal_micros()))sd_spi_hw_cancel();
 }
 sd_cli_status();return true;
}
#else
static void sd_cli_poll(void){}
static bool cmd_sd(const char *line){
 if(strcmp(line,"sd probe")&&strcmp(line,"sd status")&&strcmp(line,"sd cancel"))return false;
 cli_write_str("sd unavailable: no hardware backend in host simulation\r\nsd_write_enabled: no\r\nsd_end: 1\r\n");return true;
}
#endif
#endif
