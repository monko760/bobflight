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
hal_spi_bus_t *hal_spi_open(unsigned n){return n==4?(hal_spi_bus_t*)&b:0;}
bool hal_exti_attach(hal_pin_t p,hal_exti_cb_t cb,void *ctx){(void)p;(void)cb;(void)ctx;return false;}
void hal_delay_ms(uint32_t ms){(void)ms;}
bool hal_spi_transfer(hal_spi_bus_t *bus,hal_pin_t cs,const uint8_t *tx,uint8_t *rx,size_t n){
 (void)bus;(void)cs;if(broken)return false;memset(rx,0,n);
 if(tx[0]&128){for(size_t i=1;i<n;i++)rx[i]=regs[(tx[0]&127)+i-1];}
 else if(n==2)regs[tx[0]]=(bad_accel&&tx[0]==0x1c)?0x08:tx[1];return true;
}
static void val(unsigned a,int v){regs[a]=(unsigned)v>>8;regs[a+1]=v;}
#define CHECK(x) do {if(!(x)){fprintf(stderr,"failed line %d\n",__LINE__);return 1;}} while(0)
int main(void){float d[3];b.gyro_spi_bus=4;b.gyro_cs_pin=HAL_PIN_PACK(4,4);
 strcpy(b.gyro_chip,"MPU6000");strcpy(b.gyro_align,"CW270_DEG");regs[0x75]=0x68;regs[0x3a]=1;
 gyro_init();CHECK(healthy&&gyro_is_healthy());CHECK(regs[0x1B]==0x18&&regs[0x1C]==0x10&&regs[0x1A]==3);
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
 broken=true;CHECK(!gyro_sample(d));CHECK(!healthy&&!gyro_is_healthy());
 broken=false;bad_accel=true;gyro_init();CHECK(!gyro_is_healthy()&&!gyro_diagnostics()->config_ok);
 puts("PASS: MPU6000 setup, scaling, alignment, calibration reset and bus failure");return 0;
}
