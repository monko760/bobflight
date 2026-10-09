/* SPDX-License-Identifier: Apache-2.0. Included after SD/Blackbox CLI helpers. */
#ifndef BF_NOR_PROBE_CLI_H
#define BF_NOR_PROBE_CLI_H
#if defined(BOBFLIGHT_NOR_PROBE)
#include "drivers/nor_probe.h"
#include "hal/nor_probe_hw.h"
static nor_probe_t nor_cli;
static void nor_cli_report(void){
 char out[512],capacity[24];
 if(nor_cli.complete&&nor_cli.known)snprintf(capacity,sizeof capacity,"%lu",(unsigned long)nor_cli.capacity);
 else strcpy(capacity,"unavailable");
 snprintf(out,sizeof out,"flash_probe_api: 1\r\nflash_backend: spi-nor\r\nflash_state: %s\r\nflash_reason: %s\r\nflash_jedec: %02X %02X %02X\r\nflash_geometry_known: %s\r\nflash_capacity_bytes: %s\r\nflash_status_valid: %s\r\nflash_status: %02X\r\nflash_read_only: yes\r\nflash_recording_supported: no\r\nflash_info_end: 1\r\n",nor_cli.complete?"complete":"error",nor_cli.reason?nor_cli.reason:"not-probed",nor_cli.id[0],nor_cli.id[1],nor_cli.id[2],nor_cli.complete&&nor_cli.known?"yes":"no",capacity,nor_cli.complete?"yes":"no",nor_cli.status);
 cli_write_str(out);
}
static void nor_cli_poll(void){
 if(!nor_cli.active)return;
 if(!sd_cli_guard()||blackbox_cli_busy()||sd_read_busy()||sd_probe_busy(&cli_sd))nor_probe_cancel(&nor_cli,"state-changed");
 else nor_probe_poll(&nor_cli,hal_micros()); /* at most one byte; no wait loop */
 if(!nor_cli.active)nor_cli_report();
}
static void nor_cli_before_command(void){
 /* A new command cancels this read-only observer, never blocks arm/disarm,
  * stop, maintenance or any existing control action. Emit the old reply first. */
 if(nor_cli.active){nor_probe_cancel(&nor_cli,"interrupted-by-command");nor_cli_report();}
}
static bool cmd_nor_probe(const char *line){
 if(strcmp(line,"flash_info"))return false;
 memset(&nor_cli,0,sizeof nor_cli);nor_probe_io_t io;
 if(!sd_cli_guard()||blackbox_cli_busy()||sd_read_busy()||sd_probe_busy(&cli_sd)){nor_cli.reason="unsafe-or-busy";nor_cli_report();return true;}
 if(!nor_probe_hw_bind(&io)){nor_cli.reason="unsupported-backend";nor_cli_report();return true;}
 if(!nor_probe_begin(&nor_cli,&io,hal_micros())){io.cancel(io.ctx);nor_cli.reason="probe-refused";nor_cli_report();}
 return true; /* exactly one framed reply when background work completes */
}
#else
static void nor_cli_poll(void){}
static void nor_cli_before_command(void){}
static bool cmd_nor_probe(const char *line){
 if(strcmp(line,"flash_info"))return false;
 cli_write_str("flash_probe_api: 1\r\nflash_state: unavailable\r\nflash_reason: unsupported-backend\r\nflash_read_only: yes\r\nflash_recording_supported: no\r\nflash_info_end: 1\r\n");return true;
}
#endif
#endif
