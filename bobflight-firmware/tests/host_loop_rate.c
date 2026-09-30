/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Real scheduler + loop-rate policy + frozen `status` loop lines under a
 * simulated microsecond clock. Proves scheduling arithmetic and policy only;
 * on-hardware cascade execution time is measured by `timing`, not here. */
#include "sched/scheduler.h"
#include "sched/loop_rate.h"
#include "drivers/gyro.h"
#include "flight/arming.h"
#include "board/board.h"
#include "hal/hal.h"
#include <stdio.h>
#include <string.h>

static uint64_t now;
static uint32_t gyro_cost, pid_cost;
static unsigned gyro_calls, pid_calls;
uint64_t hal_micros(void){return now;}
void loop_gyro(void){gyro_calls++;now+=gyro_cost;}
void loop_filter(void){}
void loop_pid(void){pid_calls++;now+=pid_cost;}
void loop_mixer_dshot(void){}
void bg_rx_poll(void){}void bg_failsafe_tick(void){}void bg_cli_poll(void){}

static board_t board;static bool high_res=true,bidir,gyro_ok=true;static arm_state_t arm=ARM_DISARMED;
static gyro_diagnostics_t diag;
const board_t *board_get(void){return &board;}
bool hal_time_high_resolution(void){return high_res;}
bool dshot_bidir_enabled(void){return bidir;}
bool gyro_is_healthy(void){return gyro_ok;}
const gyro_diagnostics_t *gyro_diagnostics(void){return &diag;}
arm_state_t arming_state(void){return arm;}

static char out[2048];
static void cli_write_str(const char *s){strncat(out,s,sizeof out-strlen(out)-1);}
#include "drivers/loop_status_cli.h"

#define CHECK(x) do{if(!(x)){fprintf(stderr,"loop rate FAIL line %d: %s\n",__LINE__,#x);return 1;}}while(0)
/* Advance simulated time slice by slice (1 us steps between gyro slots). */
static void run_until(uint64_t end){
 while(now<end){scheduler_run();loop_rate_tick();if(now<end)now++;}
}
static const char *status_lines(void){static char b[160];loop_status_lines(b,sizeof b,now);return b;}
static void fast_board(void){
 memset(&board,0,sizeof board);strcpy(board.board_id,"kakute_f7_hdv");
 diag=(gyro_diagnostics_t){0};diag.config_ok=true;diag.odr_hz=8000;diag.spi_read_hz=13500000u;
 high_res=true;bidir=false;gyro_ok=true;arm=ARM_DISARMED;gyro_cost=pid_cost=0;
}
int main(void){
 const scheduler_stats_t *s=scheduler_stats();
 /* --- 8000 / 2: 4000 cascade runs per simulated second, 250 us apart. --- */
 fast_board();now=0;loop_rate_init();
 CHECK(s->gyro_hz==8000&&s->pid_process_denom==2&&s->gyro_period_us==125);
 CHECK(scheduler_loop_target_hz()==4000&&!strcmp(loop_rate_reason(),"board-profile"));
 CHECK(strstr(status_lines(),"loop_target_hz: 4000\r\nloop_actual_hz: unavailable\r\nloop_overruns: 0\r\n"));
 run_until(999999);
 CHECK(strstr(status_lines(),"loop_actual_hz: unavailable\r\n")); /* window not closed before 1 s */
 run_until(1000001);
 CHECK(pid_calls==4001&&gyro_calls==8001); /* slot at t=1 000 000 opens window 2 */
 CHECK(s->cascade_runs==4001&&s->pid_interval_last_us==250&&s->pid_jitter_max_us==0);
 uint32_t hz=0;CHECK(scheduler_loop_actual_hz(now,&hz)&&hz==4000);
 CHECK(strstr(status_lines(),"loop_target_hz: 4000\r\nloop_actual_hz: 4000\r\nloop_overruns: 0\r\n"));
 run_until(3000001);CHECK(scheduler_loop_actual_hz(now,&hz)&&hz==4000&&s->loop_window_seq==3);
 /* --- Dropped cycles: one 10 ms background stall inside a window. --- */
 now+=10000;run_until(4000001);
 CHECK(scheduler_loop_actual_hz(now,&hz)&&hz==3961&&s->skipped_deadlines==79&&s->loop_window_gyro_runs==7921);
 CHECK(strstr(status_lines(),"loop_actual_hz: 3961\r\n"));
 run_until(5000001);CHECK(scheduler_loop_actual_hz(now,&hz)&&hz==4000); /* rolling, not since boot */
 /* A cascade that stops entirely is not hidden behind the last good window. */
 now+=2500000;CHECK(scheduler_loop_actual_hz(now,&hz)&&hz==0);
 CHECK(strstr(status_lines(),"loop_actual_hz: 0\r\n"));
 run_until(now+2000300);CHECK(scheduler_loop_actual_hz(now,&hz)&&hz==4000); /* recovers once a clean window closes */
 /* --- Overruns: same since-boot counter as timing cycle_overruns. --- */
 fast_board();now=0;loop_rate_init();pid_calls=gyro_calls=0;
 gyro_cost=20;pid_cost=120; /* PID slot 140 us > 125 us gyro period */
 run_until(5000);
 CHECK(s->overruns>0&&s->overruns==pid_calls&&s->cascade_exec_max_us==140);
 char want[64];snprintf(want,sizeof want,"loop_overruns: %llu\r\n",(unsigned long long)s->overruns);
 CHECK(strstr(status_lines(),want));
 /* --- Overrun guard: two breached windows per step, 4k -> 2k -> 1k. --- */
 run_until(1000100);CHECK(s->gyro_hz==8000&&loop_rate_guard_level()==0); /* one breach */
 run_until(2000100);CHECK(loop_rate_guard_level()==1&&s->gyro_hz==4000&&s->pid_process_denom==2);
 CHECK(scheduler_loop_target_hz()==2000&&!strcmp(loop_rate_reason(),"overrun-guard"));
 uint64_t overruns_before=s->overruns;CHECK(overruns_before>0);
 /* 140 us PID slot fits the 250 us slot: no more overruns, no further drop. */
 run_until(now+4000000);CHECK(s->overruns==overruns_before&&loop_rate_guard_level()==1);
 CHECK(scheduler_loop_actual_hz(now,&hz)&&hz==2000);
 CHECK(strstr(status_lines(),"loop_target_hz: 2000\r\nloop_actual_hz: 2000\r\n"));
 pid_cost=300; /* still too slow even at 250 us */
 run_until(now+2000200);run_until(now+1000000);
 CHECK(loop_rate_guard_level()==2&&s->gyro_hz==1000&&s->pid_process_denom==1);
 CHECK(s->overruns>overruns_before); /* since-boot counter survived both rate changes */
 /* Guard never raises the rate again by itself. */
 pid_cost=0;run_until(now+3000000);CHECK(s->gyro_hz==1000&&loop_rate_guard_level()==2);
 /* --- Blocking polled bidir listen forces 1000/1; restores when off. --- */
 fast_board();now=0;loop_rate_init();CHECK(s->gyro_hz==8000);
 bidir=true;loop_rate_tick();
 CHECK(s->gyro_hz==1000&&s->pid_process_denom==1&&!strcmp(loop_rate_reason(),"dshot-bidir-polled-listen"));
 gyro_cost=1100; /* ~1 ms listen: overruns at 1 kHz are counted, never judged by the guard */
 run_until(now+3000000);CHECK(s->overruns>0&&loop_rate_guard_level()==0);
 gyro_cost=0;bidir=false;arm=ARM_ARMED;loop_rate_tick();
 CHECK(s->gyro_hz==1000); /* no rate raise while armed */
 arm=ARM_DISARMED;loop_rate_tick();CHECK(s->gyro_hz==8000&&s->pid_process_denom==2);
 CHECK(!strcmp(loop_rate_reason(),"board-profile"));
 /* A drop is applied even while armed. */
 arm=ARM_ARMED;bidir=true;loop_rate_tick();CHECK(s->gyro_hz==1000);arm=ARM_DISARMED;bidir=false;
 /* --- Other fallbacks and boards. --- */
 fast_board();high_res=false;now=0;loop_rate_init();
 CHECK(s->gyro_hz==1000&&!strcmp(loop_rate_reason(),"no-high-res-timebase"));
 fast_board();diag.odr_hz=1000;loop_rate_init();CHECK(s->gyro_hz==1000&&!strcmp(loop_rate_reason(),"gyro-odr-below-8k"));
 fast_board();diag.spi_read_hz=0;loop_rate_init();CHECK(s->gyro_hz==1000&&!strcmp(loop_rate_reason(),"gyro-spi-clock-slow"));
 fast_board();gyro_ok=false;diag.odr_hz=0;loop_rate_init();CHECK(s->gyro_hz==8000); /* no sensor: nothing to arm on */
 memset(&board,0,sizeof board);strcpy(board.board_id,"dummy");loop_rate_init();
 CHECK(s->gyro_hz==1000&&s->pid_process_denom==1&&scheduler_loop_target_hz()==1000);
 CHECK(strstr(status_lines(),"loop_target_hz: 1000\r\n"));
 strcpy(board.board_id,"tmotor_f7_v2");loop_rate_init();CHECK(s->gyro_hz==1000&&!strcmp(loop_rate_reason(),"board-profile"));
 /* --- Guard arithmetic and loop_rate report framing. --- */
 CHECK(!loop_rate_window_breach(80,8000)&&loop_rate_window_breach(81,8000)&&!loop_rate_window_breach(0,0));
 fast_board();loop_rate_init();out[0]=0;cmd_loop_rate();
 CHECK(strstr(out,"loop_rate_api: 1\r\nloop_rate_profile: 8000/2\r\nloop_rate_active: 8000/2\r\nloop_rate_reason: board-profile\r\n"));
 CHECK(strstr(out,"loop_rate_gyro_odr_hz: 8000\r\nloop_rate_gyro_spi_hz: 13500000\r\nloop_rate_end: 1\r\n"));
 /* uint64 overruns print in full. */
 {scheduler_stats_t *w=(scheduler_stats_t*)s;w->overruns=18446744073709551615ull;}
 CHECK(strstr(status_lines(),"loop_overruns: 18446744073709551615\r\n"));
 puts("PASS loop rate: 8000/2 = 4000 cascade runs/s at 250 us, rolling 1 s loop_actual_hz (unavailable, drops, stall), overrun counter, guard 4k->2k->1k, bidir/timebase/gyro fallbacks, frozen status lines");
 return 0;
}
