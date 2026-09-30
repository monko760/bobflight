/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include "drivers/gyro.h"
#include "drivers/calibration_policy.h"
#include "flight/arming.h"
#include "board/board.h"
#include "hal/hal.h"
#include <math.h>
#include <stdio.h>
#include <string.h>
static uint32_t now;
uint32_t hal_millis(void){return now;}
bool hal_usb_cdc_connected(void){return true;}
arm_state_t arming_state(void){return ARM_DISARMED;}
static board_t b;static unsigned char regs[128];static bool broken,healthy,bad_accel;
const board_t *board_get(void){return &b;}
bool board_pins_live(void){return true;}bool board_mmio_permitted(void){return false;}
void arming_set_gyro_healthy(bool h){healthy=h;}
static uint32_t spi_hz_request;static unsigned spi_set_calls,fast_writes;static bool spi_fast;
hal_spi_bus_t *hal_spi_open(unsigned n){spi_fast=false;return n==4?(hal_spi_bus_t*)&b:0;}
bool hal_exti_attach(hal_pin_t p,hal_exti_cb_t cb,void *ctx){(void)p;(void)cb;(void)ctx;return false;}
void hal_delay_ms(uint32_t ms){(void)ms;}
/* 8 kHz path: sensor reads re-clocked after configuration; count any register
 * write issued above the 1 MHz all-register limit. */
uint32_t hal_spi_set_hz(hal_spi_bus_t *bus,uint32_t max_hz){(void)bus;spi_set_calls++;spi_hz_request=max_hz;spi_fast=true;return 13500000u;}
bool hal_spi_transfer(hal_spi_bus_t *bus,hal_pin_t cs,const uint8_t *tx,uint8_t *rx,size_t n){
 (void)bus;(void)cs;if(broken)return false;memset(rx,0,n);
 if(spi_fast&&!(tx[0]&128))fast_writes++;
 if(tx[0]&128){for(size_t i=1;i<n;i++)rx[i]=regs[(tx[0]&127)+i-1];}
 else if(n==2)regs[tx[0]]=(bad_accel&&tx[0]==0x1c)?0x08:tx[1];return true;
}
static void val(unsigned a,int v){regs[a]=(unsigned)v>>8;regs[a+1]=v;}
#define CHECK(x) do {if(!(x)){fprintf(stderr,"failed line %d\n",__LINE__);return 1;}} while(0)
int main(void){float d[3];b.gyro_spi_bus=4;b.gyro_cs_pin=HAL_PIN_PACK(4,4);
 strcpy(b.gyro_chip,"MPU6000");strcpy(b.gyro_align,"CW270_DEG");regs[0x75]=0x68;regs[0x3a]=1;
 gyro_init();CHECK(healthy&&gyro_is_healthy());CHECK(regs[0x1B]==0x18&&regs[0x1C]==0x10&&regs[0x1A]==3);
 /* Non-Kakute boards keep the 1 kHz DLPF path and the configuration SPI clock. */
 CHECK(gyro_diagnostics()->odr_hz==1000&&gyro_diagnostics()->spi_read_hz==0&&spi_set_calls==0);
 val(0x3B,2048);val(0x3D,1024);val(0x3F,4096);val(0x43,164);val(0x45,-328);val(0x47,492);
 CHECK(gyro_sample(d));CHECK(fabsf(d[0]-20)<.01f&&fabsf(d[1]-10)<.01f&&fabsf(d[2]-30)<.01f);
 CHECK(fabsf(gyro_accel_g()[0]+.25f)<.001f&&fabsf(gyro_accel_g()[1]-.5f)<.001f);
 val(0x3B,0);val(0x3D,0);val(0x3F,3359);val(0x43,16);val(0x45,0);val(0x47,0);gyro_begin_calibration();
 for(int i=0;i<999;i++){++now;CHECK(gyro_sample(d));}CHECK(!gyro_calibrated());
 val(0x43,1640);++now;CHECK(gyro_sample(d));val(0x43,16);
 for(int i=0;i<1000;i++){++now;CHECK(gyro_sample(d));}CHECK(!gyro_calibrated());
 ++now;CHECK(gyro_sample(d));CHECK(gyro_calibrated());CHECK(fabsf(d[1])<.001f);
 CHECK(!gyro_flight_ready()); /* Calibrated gyro at raw ~0.82 g is not flight-ready. */
 CHECK(gyro_start_manual_calibration());CHECK(gyro_manual_calibration_active());
 CHECK(!gyro_start_accel_calibration());gyro_cancel_manual_calibration();
 CHECK(!gyro_manual_calibration_active());
 CHECK(gyro_start_accel_calibration());
 for(unsigned face=0;face<6;face++) {
  CHECK(gyro_capture_accel_face(face));float raw[3]={0,0,-.2f};
  raw[face/2u]+=(face&1u)?-1.f:1.f;
  /* Inverse CW270: body X=-sensor Y, body Y=sensor X. */
  val(0x3B,(int)(raw[1]*4096.f));val(0x3D,(int)(-raw[0]*4096.f));val(0x3F,(int)(raw[2]*4096.f));
  for(unsigned i=0;i<501;i++){now++;CHECK(gyro_sample(d));gyro_calibration_touch();gyro_calibration_tick();}
 }
 CHECK(gyro_apply_accel_calibration());CHECK(gyro_flight_ready()==!BOBFLIGHT_ACCEL_BENCH_RELAXED);
 gyro_calibration_info_t info;gyro_calibration_info(&info);
 CHECK(info.accel_valid&&info.candidate_valid&&info.faces==63&&strstr(info.apply_detail,BOBFLIGHT_ACCEL_BENCH_RELAXED?"NOT flight-qualified":"All six faces passed"));
 now+=101;CHECK(!gyro_flight_ready());now++;CHECK(gyro_sample(d));CHECK(gyro_flight_ready()==!BOBFLIGHT_ACCEL_BENCH_RELAXED);
 val(0x3F,6000);now++;CHECK(gyro_sample(d));CHECK(!gyro_flight_ready());
 val(0x3F,3277);now++;CHECK(gyro_sample(d));CHECK(gyro_flight_ready()==!BOBFLIGHT_ACCEL_BENCH_RELAXED);
 CHECK(gyro_diagnostics()->config_ok);
 uint32_t seq=gyro_diagnostics()->sample_seq;
 regs[0x3a]=0;now++;CHECK(gyro_sample(d));CHECK(gyro_diagnostics()->sample_seq==seq);
 now+=21;CHECK(!gyro_sample(d));CHECK(gyro_diagnostics()->sample_seq==seq);
 regs[0x3a]=1;now++;CHECK(gyro_sample(d));CHECK(gyro_diagnostics()->sample_seq!=seq);
 CHECK(gyro_start_accel_calibration());CHECK(gyro_manual_calibration_active());
 for(unsigned i=0;i<2001;i++){now++;CHECK(gyro_sample(d));gyro_calibration_tick();}
 CHECK(!gyro_manual_calibration_active());
 CHECK(gyro_start_accel_calibration());CHECK(gyro_capture_accel_face(4));gyro_cancel_manual_calibration();
 CHECK(!gyro_manual_calibration_active());

 gyro_calibration_info_t stored;gyro_calibration_info(&stored);
 uint32_t binding=gyro_accel_calibration_binding();CHECK(binding!=0);
 b.gyro_spi_bus=1;CHECK(!gyro_accel_restore_valid(stored.accel_bias,stored.accel_scale,binding));b.gyro_spi_bus=4;
 strcpy(b.gyro_align,"CW0_DEG");CHECK(!gyro_accel_restore_valid(stored.accel_bias,stored.accel_scale,binding));strcpy(b.gyro_align,"CW270_DEG");
 CHECK(!gyro_accel_restore_valid(stored.accel_bias,stored.accel_scale,binding^0x100));
 float invalid_scale[3]={NAN,1,1};CHECK(!gyro_accel_restore_valid(stored.accel_bias,invalid_scale,binding));
 CHECK(gyro_accel_restore_valid(stored.accel_bias,stored.accel_scale,binding)==!BOBFLIGHT_ACCEL_BENCH_RELAXED);
 gyro_init();CHECK(!gyro_calibrated());gyro_calibration_info(&info);CHECK(!info.accel_valid);
 if(!BOBFLIGHT_ACCEL_BENCH_RELAXED){
  CHECK(gyro_accel_restore_valid(stored.accel_bias,stored.accel_scale,binding));
  gyro_restore_accel_calibration(stored.accel_bias,stored.accel_scale,true);
  gyro_calibration_info(&info);CHECK(info.accel_valid&&!info.candidate_valid&&info.faces==0);
  CHECK(!gyro_calibrated()&&!gyro_flight_ready());
  CHECK(info.gyro_bias[0]==0&&info.gyro_bias[1]==0&&info.gyro_bias[2]==0);
  now++;CHECK(gyro_sample(d));CHECK(fabsf(gyro_diagnostics()->raw_acc_g[2]-.8f)<.001f);
  CHECK(fabsf(gyro_accel_g()[2]-1.f)<.001f);
  for(unsigned i=0;i<1001;i++){now++;CHECK(gyro_sample(d));}
  CHECK(gyro_calibrated());gyro_calibration_info(&info);CHECK(info.accel_valid);
  float zero[3]={0},one[3]={1,1,1};gyro_restore_accel_calibration(zero,one,false);
  gyro_calibration_info(&info);CHECK(!info.accel_valid&&gyro_calibrated());
 }
 broken=true;CHECK(!gyro_sample(d));CHECK(!healthy&&!gyro_is_healthy());
 broken=false;bad_accel=true;gyro_init();CHECK(!gyro_is_healthy()&&!gyro_diagnostics()->config_ok);
 /* Kakute F7 HDV: DLPF_CFG 0 -> 8 kHz output rate, SMPLRT_DIV 0; sensor reads
  * re-clocked (<= 20 MHz) only after every configuration write. */
 bad_accel=false;strcpy(b.board_id,"kakute_f7_hdv");spi_set_calls=fast_writes=0;
 gyro_init();CHECK(gyro_is_healthy()&&gyro_diagnostics()->config_ok);
 CHECK(regs[0x1A]==0&&regs[0x19]==0&&regs[0x1B]==0x18&&regs[0x1C]==0x10);
 CHECK(gyro_diagnostics()->odr_hz==8000&&gyro_diagnostics()->spi_read_hz==13500000u);
 CHECK(spi_set_calls==1&&spi_hz_request==20000000u&&fast_writes==0);
 regs[0x3a]=1;now++;CHECK(gyro_sample(d));CHECK(fast_writes==0);
 /* Back on a non-Kakute board the 1 kHz DLPF path returns (diagnostics reset). */
 strcpy(b.board_id,"dummy");gyro_init();CHECK(regs[0x1A]==3&&gyro_diagnostics()->odr_hz==1000&&gyro_diagnostics()->spi_read_hz==0);
 puts("PASS: MPU6000 setup, scaling, alignment, calibration reset, bus failure and Kakute 8 kHz ODR / sensor-read SPI clock");return 0;
}
