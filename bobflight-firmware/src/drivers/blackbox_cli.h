/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Included by cli.c after sd_cli.h. Owns SPI1 exclusively for a session.
 * No ISR I/O, automatic start, implicit erase, or flight-control changes. */
#ifndef BOBFLIGHT_BLACKBOX_CLI_H
#define BOBFLIGHT_BLACKBOX_CLI_H
#if defined(BOBFLIGHT_MCU)
#include "flight/blackbox_session.h"
#include "flight/blackbox_capture.h"
#include "sched/scheduler.h"
/* Configured/default logging rate. The effective rate may be lower after the
 * deterministic in-session auto-lower (blackbox_session.h); never higher. */
#ifndef BLACKBOX_RATE_DEFAULT_HZ
#define BLACKBOX_RATE_DEFAULT_HZ 500u
#endif
/* SD byte-state-machine steps per quantum; the scheduler time budget is the
 * real bound (never past the next gyro deadline minus a guard). */
#define BBL_POLL_MAX_STEPS 4096u
/* Session steps (encode batch + FAT step + one sector submit) per background call. */
#define BBL_SESSION_STEPS_MAX 64u
static bb_session_t bbl;
static sd_spi_t bbl_card;
static bool bbl_initializing,bbl_stop_during_init;
static uint64_t bbl_init_start,bbl_deadline;
static bool blackbox_cli_busy(void){return bbl_initializing||bb_session_busy(&bbl);}
static bool bbl_read(void *ctx,uint32_t sector,uint8_t *out){return sd_spi_begin_read(ctx,sector,out,hal_micros())==SD_SPI_OK;}
static bool bbl_write(void *ctx,uint32_t sector,const uint8_t *data){return sd_spi_begin_write(ctx,sector,data,hal_micros())==SD_SPI_OK;}
static int bbl_card_poll(void *ctx,uint64_t now){
 /* Deadline-bounded background quantum; never an unbounded card-ready wait.
  * The previous fixed 8 us / 16-step quantum moved only ~5 SPI bytes per call. */
 sd_spi_status_t result=SD_SPI_ERR_BUSY;
 for(unsigned n=0;n<BBL_POLL_MAX_STEPS;n++){
  result=sd_poll(ctx,now);if(result!=SD_SPI_ERR_BUSY)break;
  now=hal_micros();if(now>=bbl_deadline)break;
 }
 return result==SD_SPI_OK?1:result==SD_SPI_ERR_BUSY?0:-1;
}
static void blackbox_cli_poll(void){
 if(!bbl_initializing&&!bb_session_busy(&bbl))return;
 uint64_t start=hal_micros();bbl_deadline=start+scheduler_bg_budget_us(start);
 if(bbl_initializing){
  int state=bbl_card_poll(&bbl_card,start);
  if(state==0)return;
  bbl_initializing=false;
  if(state<0||bbl_stop_during_init){bbl.phase=state<0?BBS_ERROR:BBS_DONE;bbl.reason=state<0?"card-init-failed":"stopped-before-file-creation";sd_spi_hw_cancel();return;}
  const scheduler_stats_t *sched=scheduler_stats();
  uint32_t loop_hz=sched->pid_process_denom?sched->gyro_hz/sched->pid_process_denom:0;
  /* Header states the rate actually used at start; a mid-session auto-lower
   * patches the fixed-width rate block in place before close. */
  blackbox_metadata_t m={BLACKBOX_RATE_DEFAULT_HZ,loop_hz,dshot_speed_kbps(),BOBFLIGHT_VERSION_STRING,config_get(),BLACKBOX_RATE_DEFAULT_HZ,BB_RATE_REASON_DEFAULT};
  fatlog_io_t io={&bbl_card,bbl_card.card_info.capacity_sectors,bbl_read,bbl_write,bbl_card_poll};
  if(!bb_session_start(&bbl,&io,&m,hal_micros()))sd_spi_hw_cancel();
  return;
 }
 for(unsigned n=0;n<BBL_SESSION_STEPS_MAX&&bb_session_busy(&bbl);n++){
  bb_session_poll(&bbl,hal_micros());
  if(hal_micros()>=bbl_deadline)break;
 }
 if(bbl.phase==BBS_DONE||bbl.phase==BBS_ERROR)sd_spi_hw_cancel();
}
static void bbl_status(void){
 const flight_recorder_stats_t *s=recorder_stats();char out[1024];
 /* api 2: all api-1 keys keep their names/order; new keys precede blackbox_end.
  * blackbox_rate_hz is the effective rate (no longer a hardcoded 500). */
 bool ran=bbl.phase!=BBS_IDLE&&bbl.sample_hz;
 uint32_t requested=ran&&bbl.requested_hz?bbl.requested_hz:BLACKBOX_RATE_DEFAULT_HZ;
 uint32_t effective=ran?bbl.sample_hz:requested;
 const char *rate_reason=ran&&bbl.rate_reason?bbl.rate_reason:BB_RATE_REASON_DEFAULT;
 uint64_t frames=bbl.frames,dropped=s->total_dropped,total=frames+dropped;
 unsigned long tenths=total?(unsigned long)((dropped*1000u+total/2u)/total):0ul;
 snprintf(out,sizeof out,"blackbox_api: 2\r\nblackbox_state: %s\r\nblackbox_reason: %s\r\nblackbox_file: %s\r\nblackbox_bytes: %llu\r\nblackbox_frames: %lu\r\nblackbox_rate_hz: %lu\r\nblackbox_dropped: %lu\r\nblackbox_missed: %lu\r\nblackbox_invalid: %lu\r\nblackbox_queue: %lu\r\nblackbox_active: %u\r\nblackbox_rate_requested_hz: %lu\r\nblackbox_rate_reason: %s\r\nblackbox_drop_pct: %lu.%lu\r\nblackbox_end: 1\r\n",
 bbl_initializing?"initializing":bb_session_name(&bbl),bbl.reason?bbl.reason:"not-started",bbl.file.filename,
 (unsigned long long)bbl.file.bytes_written,(unsigned long)bbl.frames,(unsigned long)effective,(unsigned long)s->total_dropped,(unsigned long)s->total_missed,(unsigned long)s->total_invalid,(unsigned long)s->queue_depth,blackbox_cli_busy()?1:0,
 (unsigned long)requested,rate_reason,tenths/10ul,tenths%10ul);
 cli_write_str(out);
}
static bool cmd_blackbox(const char *line){
 if(strcmp(line,"blackbox start")&&strcmp(line,"blackbox stop")&&strcmp(line,"blackbox status"))return false;
 if(!strcmp(line,"blackbox start")){
  if(blackbox_cli_busy()||sd_read_busy()||sd_probe_busy(&cli_sd)||!sd_cli_guard()||persist_dirty()){
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
 if(!blackbox_cli_busy()&&!sd_read_busy())return false;
 if(!strncmp(line,"sd read",7))return false;
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
