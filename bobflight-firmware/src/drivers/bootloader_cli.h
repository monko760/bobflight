/* SPDX-License-Identifier: Apache-2.0
 * Included by cli.c. Nonblocking CDC acknowledgement window; no automatic save.
 * bench_motor_active includes an enabled AUX session and pending stop output.
 */
#ifndef BOBFLIGHT_BOOTLOADER_CLI_H
#define BOBFLIGHT_BOOTLOADER_CLI_H
#include <ctype.h>
static bool bl_pending,bl_discard;
static uint32_t bl_started;
static bool bl_equal(const char *a,const char *b){while(*a&&*b){if(tolower((unsigned char)*a++)!=tolower((unsigned char)*b++))return false;}return *a==*b;}
static bool bl_safe(void){return arming_state()!=ARM_ARMED&&!bench_motor_active()&&!gyro_manual_calibration_active();}
static bool cmd_bootloader(const char *line){
 bool discard=bl_equal(line,"bl discard");
 if(!discard&&!bl_equal(line,"bl"))return false;
 if(!bl_safe()){cli_write_str("bl refused: disarm, bench_stop and finish/cancel manual calibration\r\n");return true;}
 if(!hal_bootloader_supported()){cli_write_str("bl unavailable: unsupported board/MCU or invalid ROM vectors\r\n");return true;}
 if(persist_dirty()&&!discard){cli_write_str("bl refused: unsaved configuration; diff all then save, or bl discard to explicitly lose unsaved RAM changes\r\n");return true;}
 bl_discard=discard;bl_started=hal_millis();bl_pending=true;
 cli_write_str("bl: resetting to ST ROM bootloader; RAM-only calibration/settings will be lost; no automatic save\r\n");
 return true;
}
static void bootloader_poll(void){
 if(!bl_pending||(uint32_t)(hal_millis()-bl_started)<100u)return;
 /* Recheck after the acknowledgement window; never reset an active aircraft. */
 if(!bl_safe()||(!bl_discard&&persist_dirty())){bl_pending=false;cli_write_str("bl cancelled: safety/configuration state changed\r\n");return;}
 bl_pending=false;
 (void)hal_bootloader_request(); /* success never returns */
 cli_write_str("bl failed: bootloader reset unavailable; normal firmware retained\r\n");
}
#endif
