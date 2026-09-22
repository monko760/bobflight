/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Included by cli.c after sd_cli.h. Owns SPI1 exclusively for a session.
 * No ISR I/O, automatic start, implicit erase, or flight-control changes. */
#ifndef BOBFLIGHT_BLACKBOX_CLI_H
#define BOBFLIGHT_BLACKBOX_CLI_H
#if defined(BOBFLIGHT_MCU)
#include "flight/blackbox_session.h"
#include "flight/blackbox_capture.h"
#include "sched/scheduler.h"
static bb_session_t bbl;
static sd_spi_t bbl_card;
static bool bbl_initializing,bbl_stop_during_init;
static uint64_t bbl_init_start;
static bool blackbox_cli_busy(void){return bbl_initializing||bb_session_busy(&bbl);}
static bool bbl_read(void *ctx,uint32_t sector,uint8_t *out){return sd_spi_begin_read(ctx,sector,out,hal_micros())==SD_SPI_OK;}
static bool bbl_write(void *ctx,uint32_t sector,const uint8_t *data){return sd_spi_begin_write(ctx,sector,data,hal_micros())==SD_SPI_OK;}
static int bbl_card_poll(void *ctx,uint64_t now){
 /* Bounded background quantum; never an unbounded card-ready wait. */
 sd_spi_status_t result=SD_SPI_ERR_BUSY;uint64_t start=hal_micros();
 for(unsigned n=0;n<16;n++){
  result=sd_poll(ctx,now);if(result!=SD_SPI_ERR_BUSY)break;
  now=hal_micros();if(now<start||now-start>=8u)break;
 }
 return result==SD_SPI_OK?1:result==SD_SPI_ERR_BUSY?0:-1;
}
static void blackbox_cli_poll(void){
 if(bbl_initializing){
  int state=bbl_card_poll(&bbl_card,hal_micros());
  if(state==0)return;
  bbl_initializing=false;
  if(state<0||bbl_stop_during_init){bbl.phase=state<0?BBS_ERROR:BBS_DONE;bbl.reason=state<0?"card-init-failed":"stopped-before-file-creation";sd_spi_hw_cancel();return;}
  const scheduler_stats_t *sched=scheduler_stats();
  uint32_t loop_hz=sched->pid_process_denom?sched->gyro_hz/sched->pid_process_denom:0;
  blackbox_metadata_t m={500,loop_hz,dshot_speed_kbps(),BOBFLIGHT_VERSION_STRING,config_get()};
  fatlog_io_t io={&bbl_card,bbl_card.card_info.capacity_sectors,bbl_read,bbl_write,bbl_card_poll};
  if(!bb_session_start(&bbl,&io,&m,hal_micros()))sd_spi_hw_cancel();
  return;
 }
 if(!bb_session_busy(&bbl))return;
 bb_session_poll(&bbl,hal_micros());
 if(bbl.phase==BBS_DONE||bbl.phase==BBS_ERROR)sd_spi_hw_cancel();
}
static void bbl_status(void){
 const flight_recorder_stats_t *s=recorder_stats();char out[768];
 snprintf(out,sizeof out,"blackbox_api: 1\r\nblackbox_state: %s\r\nblackbox_reason: %s\r\nblackbox_file: %s\r\nblackbox_bytes: %llu\r\nblackbox_frames: %lu\r\nblackbox_rate_hz: 500\r\nblackbox_dropped: %lu\r\nblackbox_missed: %lu\r\nblackbox_invalid: %lu\r\nblackbox_queue: %lu\r\nblackbox_active: %u\r\nblackbox_end: 1\r\n",
 bbl_initializing?"initializing":bb_session_name(&bbl),bbl.reason?bbl.reason:"not-started",bbl.file.filename,
 (unsigned long long)bbl.file.bytes_written,(unsigned long)bbl.frames,(unsigned long)s->total_dropped,(unsigned long)s->total_missed,(unsigned long)s->total_invalid,(unsigned long)s->queue_depth,blackbox_cli_busy()?1:0);
 cli_write_str(out);
}
static bool cmd_blackbox(const char *line){
 if(strcmp(line,"blackbox start")&&strcmp(line,"blackbox stop")&&strcmp(line,"blackbox status"))return false;
 if(!strcmp(line,"blackbox start")){
  if(blackbox_cli_busy()||sd_probe_busy(&cli_sd)||!sd_cli_guard()||persist_dirty()){
   cli_write_str("blackbox refused: disarm, stop motor tests/calibration/probe, save configuration, connect USB and finish any current recording\r\nblackbox_end: 1\r\n");return true;
  }
  sd_spi_io_t io;sd_spi_hw_cancel();
  if(!sd_spi_hw_bind(&io)){cli_write_str("blackbox unavailable: unsupported SD backend\r\nblackbox_end: 1\r\n");return true;}
  memset(&bbl,0,sizeof bbl);recorder_reset();sd_spi_init_ctx(&bbl_card,&io);bbl_init_start=hal_micros();
  if(sd_spi_begin_init(&bbl_card,bbl_init_start)!=SD_SPI_OK){bbl.phase=BBS_ERROR;bbl.reason="card-init-refused";sd_spi_hw_cancel();}
  else {bbl_initializing=true;bbl_stop_during_init=false;bbl.reason="initializing-card";}
 }
 if(!strcmp(line,"blackbox stop")){
  if(bbl_initializing)bbl_stop_during_init=true;
  else bb_session_stop(&bbl);
 }
 bbl_status();return true;
}
/* Freeze file-header configuration and serialize maintenance against SD writes.
 * Normal arm/disarm and explicit motor-stop commands remain available. */
static bool blackbox_cli_filter(const char *line){
 if(!blackbox_cli_busy())return false;
 const char *safe[]={"blackbox status","blackbox stop","blackbox start","arm","disarm","bench_stop","calibration_cancel","help","version","status","storage","calibration","control_mode","sensors","receiver","modes","ports","power","timing","pid_diag","pid_diag status","bench_status","diff","dump","diff all","dump all","sd probe","sd status","sd cancel"};
 for(unsigned i=0;i<sizeof safe/sizeof safe[0];i++)if(!strcmp(line,safe[i]))return false;
 cli_write_str("command refused: stop Blackbox recording and wait for done before configuration, calibration, motor tests, reboot or bootloader entry\r\n");
 if(!strncmp(line,"mode_range ",11)||!strncmp(line,"control_source ",15))cli_write_str("modes_end: 1\r\n");
 else if(!strncmp(line,"pid_diag ",9))cli_write_str("pid_diag_end: 1\r\n");
 return true;
}
#else

static void blackbox_cli_poll(void){}
static bool blackbox_cli_filter(const char *line){(void)line;return false;}
static bool cmd_blackbox(const char *line){
 if(strcmp(line,"blackbox start")&&strcmp(line,"blackbox stop")&&strcmp(line,"blackbox status"))return false;
 cli_write_str("blackbox unavailable: no physical SD backend in host simulation\r\nblackbox_end: 1\r\n");return true;
}
#endif
#endif
