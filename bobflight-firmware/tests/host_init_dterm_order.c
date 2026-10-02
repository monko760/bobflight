/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Safety S1 (PR #61 review): the REAL app_init() (src/app/init.c) decides the
 * D-term filter order from the gyro output rate it has just configured:
 *   Kakute F7 HDV, loop_rate_hz 4000 (default) or 8000 -> MPU6000 at 8 kHz
 *     ODR (DLPF 0) -> second D stage ON;
 *   Kakute at loop_rate_hz 1000 -> 1 kHz ODR -> OFF;
 *   tmotor_f7_v2 (1 kHz ODR only) -> OFF;  sensor rate write failed -> OFF.
 * Real init.c, pid.c (queried via pid_dterm_lpf_pt2), config.c and
 * loop_rate_setting.c; every other boot dependency is a stub. The gyro stub
 * models the driver's ODR bookkeeping: gyro_init() configures the board's
 * fast path (8 kHz on Kakute, like configure_mpu6k(board_fast)), then
 * gyro_select_output_rate(fast) sets 8000 / 1000, or 0 when the write fails.
 * So the decision must be taken AFTER the rate select, from the reported ODR.
 * No firmware behaviour change: tests only. */
#include "app/init.h"
#include "board/board.h"
#include "drivers/gyro.h"
#include "flight/pid.h"
#include "sched/loop_rate_setting.h"
#include "hal/hal.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define REQUIRE(c) do{if(!(c)){fprintf(stderr,"init_dterm_order FAIL line %d: %s\n",__LINE__,#c);exit(1);}}while(0)
static board_t board;
static gyro_diagnostics_t diag;
static bool select_fails;static int select_calls;static uint32_t saved_loop_rate;
static void set_board(const char *id){memset(&board,0,sizeof board);strcpy(board.board_id,id);board.motor_count=4;}
/* Boot dependencies (stubs). */
bool board_init(void){return true;}
const board_t *board_get(void){return &board;}
bool board_mmio_permitted(void){return false;}
void hal_gpio_init(hal_pin_t p,hal_gpio_mode_t m){(void)p;(void)m;}
void hal_gpio_write(hal_pin_t p,bool v){(void)p;(void)v;}
void hal_clock_init(uint32_t hse){(void)hse;}
void hal_time_init(void){}
const char *hal_clock_usb_src(void){return "host";}
bool hal_usb_cdc_init(void){return true;}
void cli_init(void){}
void motor_safe_idle(void){}
void dshot_init(void){}
void dshot_bidir_set_enabled(bool on){(void)on;}
void rx_init(void){}
void persist_init(void){}
void power_init(void){}
void mixer_init(void){}
void rates_init(void){}
void mode_range_init(void){}
void arming_init(void){}
void failsafe_init(void){}
void arming_set_gyro_healthy(bool h){(void)h;}
bool gyro_is_healthy(void){return true;}
bool persist_load(void){if(saved_loop_rate)REQUIRE(loop_rate_setting_set(saved_loop_rate));return true;}
void loop_rate_init(void){}
void rpm_filter_gyro_install(void){} /* #60: RPM post-filter registration */
/* Gyro ODR bookkeeping as in drivers/gyro.c. */
static bool kakute(void){return strcmp(board.board_id,"kakute_f7_hdv")==0;}
void gyro_init(void){memset(&diag,0,sizeof diag);diag.config_ok=true;diag.odr_hz=kakute()?8000u:1000u;}
bool gyro_select_output_rate(bool fast){
 select_calls++;
 if(!kakute()){diag.odr_hz=1000u;return !fast;}          /* no 8 kHz path */
 if(select_fails){diag.config_ok=false;diag.odr_hz=0u;return false;}
 diag.odr_hz=fast?8000u:1000u;return true;
}
const gyro_diagnostics_t *gyro_diagnostics(void){return &diag;}
static bool boot(const char *id,uint32_t saved,bool fails){
 set_board(id);saved_loop_rate=saved;select_fails=fails;select_calls=0;
 loop_rate_setting_defaults();
 REQUIRE(app_init());REQUIRE(select_calls==1);
 return pid_dterm_lpf_pt2();
}
int main(void){
 REQUIRE(boot("kakute_f7_hdv",0,false)==true);    /* default 4000 -> 8000/2, 8 kHz ODR */
 REQUIRE(diag.odr_hz==8000u);
 REQUIRE(boot("tmotor_f7_v2",0,false)==false);    /* 1 kHz ODR: turned OFF again */
 REQUIRE(diag.odr_hz==1000u);
 REQUIRE(boot("kakute_f7_hdv",8000,false)==true); /* saved 8000 -> 8000/1 */
 REQUIRE(boot("kakute_f7_hdv",1000,false)==false);/* saved 1000: gyro_init had 8 kHz, select -> 1 kHz */
 REQUIRE(boot("kakute_f7_hdv",0,true)==false);    /* rate write failed: ODR 0 */
 REQUIRE(boot("dummy",0,false)==false);
 puts("PASS init_dterm_order: real app_init turns the second D stage ON for Kakute at 8 kHz ODR (loop_rate_hz 4000/8000), OFF for tmotor_f7_v2 (1 kHz), Kakute at 1000, dummy, and a failed rate write; decided after the rate select");
 return 0;
}
