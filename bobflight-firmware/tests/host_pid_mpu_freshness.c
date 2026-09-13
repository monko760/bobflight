/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Actual MPU6000 DATA_RDY driver + isolated PID, mocked SPI/time, no hardware.
 * Zero-based iterations; axes 0/1/2=roll/pitch/yaw. */
#include "drivers/gyro.h"
#include "flight/pid_diag.h"
#include "flight/pid.h"
#include "flight/config.h"
#include "flight/arming.h"
#include "board/board.h"
#include "hal/hal.h"
#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static uint64_t clock_us;
static board_t board;
static uint8_t registers[128];
static bool healthy;
uint32_t hal_millis(void){return (uint32_t)(clock_us/1000);}
uint64_t hal_micros(void){return clock_us;}
bool hal_usb_cdc_connected(void){return true;}
arm_state_t arming_state(void){return ARM_DISARMED;}
const board_t *board_get(void){return &board;}
bool board_pins_live(void){return true;}
bool board_mmio_permitted(void){return false;}
void arming_set_gyro_healthy(bool h){healthy=h;}
hal_spi_bus_t *hal_spi_open(unsigned n){return n==4?(hal_spi_bus_t*)&board:NULL;}
bool hal_exti_attach(hal_pin_t p,hal_exti_cb_t cb,void *ctx){(void)p;(void)cb;(void)ctx;return false;}
void hal_delay_ms(uint32_t ms){(void)ms;}
bool bench_motor_active(void){return false;}
bool rx_frame_fresh(void){return false;}
const float *rx_channels(void){static float rc[16];return rc;}
bool hal_spi_transfer(hal_spi_bus_t *bus,hal_pin_t cs,const uint8_t *tx,uint8_t *rx,size_t n){
 (void)bus;(void)cs;memset(rx,0,n);
 if(tx[0]&128){for(size_t i=1;i<n;i++)rx[i]=registers[(tx[0]&127)+i-1];}
 else if(n==2)registers[tx[0]]=tx[1];
 return true;
}
static void reg16(unsigned a,int v){registers[a]=(unsigned)v>>8;registers[a+1]=v;}
static pid_diag_snapshot_t snapshot(void){pid_diag_snapshot_t s;pid_diag_get_snapshot(&s);return s;}
static void emit_frame(void){
 if(getenv("BOBFLIGHT_PID_FRAME_DUMP")){char b[1024];pid_diag_cli_process("pid_diag",b,sizeof(b));assert(strstr(b,"pid_diag_end: 1\r\n"));fputs(b,stdout);}
}
int main(void){
 float raw[3],filtered[3];
 board.gyro_spi_bus=4;board.gyro_cs_pin=HAL_PIN_PACK(4,4);
 strcpy(board.gyro_chip,"MPU6000");strcpy(board.gyro_align,"CW0_DEG");
 registers[0x75]=0x68;registers[0x3a]=1;
 gyro_init();assert(healthy&&gyro_is_healthy());
 reg16(0x3f,3359); /* ~0.82g, deliberately NOT flight-qualified. */
 for(unsigned i=0;i<1001;i++){clock_us+=1000;assert(gyro_sample(raw));}
 assert(gyro_calibrated());assert(!gyro_flight_ready());
 config_init();pid_init();pid_diag_init();assert(pid_diag_start(PID_DIAG_SOURCE_ZERO,NULL));
 reg16(0x43,164);reg16(0x45,-328);reg16(0x47,492);
 uint64_t last_compute=0;unsigned waits=0,computations=0;
 uint32_t sensor_seq=gyro_diagnostics()->sample_seq;
 for(unsigned i=0;i<5000;i++){
  const bool ready=(i%100)!=99;
  registers[0x3a]=ready?1:0;clock_us+=1000;
  assert(gyro_sample(raw));gyro_filter(raw,filtered);
  assert(gyro_diagnostics()->sample_seq==sensor_seq+(ready?1u:0u));
  sensor_seq=gyro_diagnostics()->sample_seq;
  pid_diag_update(clock_us,filtered);pid_diag_snapshot_t s=snapshot();
#ifdef PID_EXPECT_OLD
  if(!ready)waits++;
#else
  assert(s.active&&s.reset_count==0);
  if(i==0||i==97||i==99||i==100)emit_frame();
  if(i==0){assert(!s.valid);last_compute=clock_us;continue;}
  if(!ready){
   waits++;assert(!s.valid&&!strcmp(s.reason,"waiting-new-sample"));
   assert(s.sample_seq==computations&&s.dt_us==0&&s.wait_count==waits);
   for(unsigned a=0;a<3;a++)assert(s.correction[a]==0&&s.gyro_dps[a]==0&&s.error_dps[a]==0);
   continue;
  }
  assert(s.valid);computations++;assert(s.sample_seq==computations);
  assert(s.dt_us==clock_us-last_compute);
  pid_axis_out_t ref;float demand[3]={0};
  pid_set_dt((float)(clock_us-last_compute)*0.000001f);pid_update(filtered,demand,&ref);
  assert(fabsf(s.correction[0]-ref.roll)<1e-6f);
  assert(fabsf(s.correction[1]-ref.pitch)<1e-6f);
  assert(fabsf(s.correction[2]-ref.yaw)<1e-6f);
  last_compute=clock_us;
#endif
 }
 pid_diag_snapshot_t s=snapshot();
#ifdef PID_EXPECT_OLD
 assert(waits==50&&s.reset_count==50);
 printf("REPRODUCED old mismatch: %u DATA_RDY waits -> %u resets over5000 attempts\n",waits,s.reset_count);
#else
 assert(waits==50&&computations==4949&&s.reset_count==0&&s.wait_count==50);
 pid_diag_stop("explicit-stop");s=snapshot();assert(!s.active&&!s.valid&&s.reset_count==1);emit_frame();
 puts("PASS actual MPU6000 DATA_RDY + diagnostic:5000 attempts,50 waits,4949 computations,zero spurious resets,original-equation I/D continuity and active stop. Not physical hardware/flight validation.");
#endif
 return 0;
}
