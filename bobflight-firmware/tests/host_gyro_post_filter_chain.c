/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Safety S1 + #60 (QA F3): the RPM post-filter stays INSIDE S1's gyro filter
 * chain. Real gyro.c (target chain via BOBFLIGHT_HOST_GYRO_CHAIN=1), real
 * scheduler.c + tasks.c, real filter_gyro_chain_step; the post-filter is a spy
 * registered with gyro_set_post_filter (what rpm_filter_gyro_install does).
 * Asserts, at 8000/2, 8000/1 and 1000/1:
 *  - the post-filter runs once per gyro sample (calls == gyro_runs), not per
 *    PID cycle (8000/2 would give half);
 *  - with dt = 1/gyro_hz (the gyro-sample dt, not the PID dt);
 *  - on the output of the LPF + notches: its input equals, bit for bit, a
 *    reference filter_gyro_chain_step fed the same samples (fails if the call
 *    moves before or outside the chain);
 *  - and its output is what gyro_filter() returns (not discarded). */
#include "sched/scheduler.h"
#include "sched/tasks.h"
#include "drivers/rx.h"
#include "drivers/rx_internal.h"
#include "drivers/gyro.h"
#include "flight/config.h"
#include "flight/filter.h"
#include "flight/arming.h"
#include "flight/attitude.h"
#include "flight/failsafe.h"
#include "flight/mode_range.h"
#include "flight/pid.h"
#include "flight/rates.h"
#include "drivers/dshot.h"
#include "board/board.h"
#include "hal/hal.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define REQUIRE(c) do{if(!(c)){fprintf(stderr,"gyro_post_filter_chain FAIL line %d: %s\n",__LINE__,#c);exit(1);}}while(0)
static uint64_t now;static board_t board;
struct hal_tim_dma {unsigned index;};static struct hal_tim_dma slots[4];static unsigned opens;
uint64_t hal_micros(void){return now;}
uint32_t hal_millis(void){return (uint32_t)(now/1000);}
bool hal_usb_cdc_connected(void){return true;}
const board_t *board_get(void){return &board;}
bool board_pins_live(void){return true;}
bool board_mmio_permitted(void){return false;}
void hal_gpio_init(hal_pin_t p,hal_gpio_mode_t m){(void)p;(void)m;}
void hal_gpio_write(hal_pin_t p,bool v){(void)p;(void)v;}
bool hal_tim_dma_set_bit_rate(uint32_t h){return h==300000||h==600000;}
bool dshot_bidir_enabled(void){return false;}
void dshot_telem_arm_listen(unsigned m){(void)m;}
void dshot_telem_arm_listen_all(void){}
void dshot_telem_poll_all(void){}
hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *c){(void)c;if(opens>=4)return 0;slots[opens].index=opens;return &slots[opens++];}
bool hal_tim_dma_start_burst(hal_tim_dma_t *s,const uint16_t *w,size_t n){(void)s;(void)w;(void)n;return true;}
hal_uart_t *hal_uart_open_cfg(const hal_uart_cfg_t *c){(void)c;return (hal_uart_t*)&board;}
size_t hal_uart_read(hal_uart_t *u,uint8_t *b,size_t n){(void)u;(void)b;(void)n;return 0;}
hal_spi_bus_t *hal_spi_open(unsigned n){(void)n;return 0;}
bool hal_exti_attach(hal_pin_t p,hal_exti_cb_t cb,void *ctx){(void)p;(void)cb;(void)ctx;return false;}
void hal_delay_ms(uint32_t ms){(void)ms;}
uint32_t hal_spi_set_hz(hal_spi_bus_t *b,uint32_t hz){(void)b;return hz;}
bool hal_spi_transfer(hal_spi_bus_t *b,hal_pin_t cs,const uint8_t *tx,uint8_t *rx,size_t n){(void)b;(void)cs;(void)tx;(void)rx;(void)n;return false;}
void cli_poll(void){}
void pid_diag_update(uint64_t t,const float g[3]){(void)t;(void)g;}
/* Spy post-filter + reference chain fed the same samples. */
static unsigned long calls;static bool dt_ok,order_ok;static float want_dt,ref_state[3],last_in[3];
static filter_notch_bank_t ref_notch;static float ref_out[3];
static void spy(float v[3],float dt){
 calls++;if(dt!=want_dt)dt_ok=false;
 if(memcmp(v,ref_out,sizeof ref_out)!=0)order_ok=false;
 v[0]+=1000.f;                              /* marker: must reach gyro_filter's output */
}
static const float TWO_PI=6.28318531f;
static void run(uint32_t g,uint32_t d){
 now=1000000;opens=0;memset(&board,0,sizeof board);strcpy(board.board_id,"kakute_f7_hdv");board.motor_count=4;
 board.gyro_cs_pin=HAL_PIN_INVALID;board.rx_uart=4;board.rx_pin=HAL_PIN_PACK(0,1);
 for(unsigned i=0;i<4;i++)board.motors[i]=(board_motor_ch_t){HAL_PIN_PACK(1,i),3,i+1};
 config_init();mode_range_init();rx_init();failsafe_init();arming_init();attitude_init();rates_init();pid_init();dshot_init();
 /* After every init (one of them restores config defaults): a 200 Hz notch. */
 REQUIRE(config_set_key("gyro_notch1_cutoff_hz",150.f)&&config_set_key("gyro_notch1_hz",200.f));
 gyro_init();gyro_set_post_filter(spy);
 const float z[3]={0,0,0};gyro_host_inject_dps(z,true);
 scheduler_init(g,d);
 {bool a=false;const char *r=0;REQUIRE(gyro_notch_status(1,&a,&r)&&a);}   /* the notch is live in gyro.c */
 want_dt=1.f/(float)g;calls=0;dt_ok=order_ok=true;memset(ref_state,0,sizeof ref_state);filter_notch_bank_init(&ref_notch);
 const float c[2]={200.f,0.f},f[2]={150.f,0.f};(void)filter_notch_bank_update(&ref_notch,c,f,want_dt);
 const unsigned long runs0=scheduler_stats()->gyro_runs;unsigned long seen=runs0;
 const uint64_t t0=now;
 while(now-t0<200000){
  now+=5;const float t=(float)(now-t0)*1e-6f;
  const float in[3]={10.f*sinf(TWO_PI*200.f*t)+3.f*sinf(TWO_PI*37.f*t),5.f*sinf(TWO_PI*311.f*t),2.f};
  gyro_host_inject_dps(in,true);
  /* Reference output for the sample the scheduler would take now. */
  float ro[3];float st[3];memcpy(st,ref_state,sizeof st);filter_notch_bank_t nb=ref_notch;
  filter_gyro_chain_step(st,&nb,config_get()->gyro_lpf_hz,want_dt,in,ro);
  memcpy(ref_out,ro,sizeof ro);
  scheduler_run();
  if(scheduler_stats()->gyro_runs!=seen){             /* a gyro sample was taken: commit the reference */
   REQUIRE(scheduler_stats()->gyro_runs==seen+1);seen++;memcpy(ref_state,st,sizeof st);ref_notch=nb;memcpy(last_in,in,sizeof in);
  }
 }
 const unsigned long runs=scheduler_stats()->gyro_runs-runs0;
 printf("%u/%u: gyro samples %lu, post-filter calls %lu, dt %s, input == LPF+notch output %s\n",g,d,runs,calls,dt_ok?"1/gyro_hz":"WRONG",order_ok?"yes":"NO");
 REQUIRE(runs>(unsigned long)(g/5)-2);
 REQUIRE(calls==runs);      /* every gyro sample, not every PID cycle */
 REQUIRE(dt_ok);            /* gyro-sample dt */
 REQUIRE(order_ok);         /* after LPF + notches, bit-exact */
 /* The spy's marker is in gyro_filter's output. */
 float in[3]={1.f,2.f,3.f},out[3];gyro_filter_set_dt(want_dt);gyro_filter(in,out);
 REQUIRE(out[0]>900.f);
}
int main(void){
 run(8000,2);run(8000,1);run(1000,1);
 puts("PASS gyro_post_filter_chain: the RPM post-filter runs inside gyro_filter after LPF + notches, once per gyro sample at dt = 1/gyro_hz (8000/2, 8000/1, 1000/1), and its output is the filtered gyro");
 return 0;
}
