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
uint32_t hal_spi_set_hz(hal_spi_bus_t *bus,uint32_t max_hz){(void)bus;spi_set_calls++;spi_hz_request=max_hz;spi_fast=max_hz>1000000u;return spi_fast?13500000u:843750u;}
bool hal_spi_transfer(hal_spi_bus_t *bus,hal_pin_t cs,const uint8_t *tx,uint8_t *rx,size_t n){
 (void)bus;(void)cs;if(broken)return false;memset(rx,0,n);
 if(spi_fast&&!(tx[0]&128))fast_writes++;
 if(tx[0]&128){for(size_t i=1;i<n;i++)rx[i]=regs[(tx[0]&127)+i-1];}
 else if(n==2)regs[tx[0]]=(bad_accel&&tx[0]==0x1c)?0x08:tx[1];return true;
}
static void val(unsigned a,int v){regs[a]=(unsigned)v>>8;regs[a+1]=v;}
#define CHECK(x) do {if(!(x)){fprintf(stderr,"failed line %d\n",__LINE__);return 1;}} while(0)
/* Frozen pre-orientation implementation, representing stored old calibration. */
static uint32_t legacy_binding(void) {
 uint32_t h=2166136261u;
 for(const unsigned char *p=(const unsigned char*)b.gyro_align;*p;p++)h=(h^*p)*16777619u;
 uint32_t resource[2]={b.gyro_spi_bus,(uint32_t)b.gyro_cs_pin};
 for(unsigned i=0;i<2;i++)for(unsigned shift=0;shift<32;shift+=8)h=(h^((resource[i]>>shift)&255u))*16777619u;
 h=(h^1u)*16777619u;h=(h^0x68u)*16777619u;h=(h^0x10u)*16777619u;
 return h;
}
int main(void) {
 const char *names[]={"CW0_DEG","CW90_DEG","CW180_DEG","CW270_DEG"};
 /* Independent explicit expected vectors, not a call to the transform under test. */
 const float expected_g[4][3]={{10,-20,30},{-20,-10,30},{-10,20,30},{20,10,30}};
 const float expected_a[4][3]={{.5f,.25f,1},{.25f,-.5f,1},{-.5f,-.25f,1},{-.25f,.5f,1}};
 b.gyro_spi_bus=4;b.gyro_cs_pin=HAL_PIN_PACK(4,4);strcpy(b.gyro_chip,"MPU6000");
 for(unsigned rotation=0;rotation<4;rotation++) {
  memset(regs,0,sizeof(regs));regs[0x75]=0x68;regs[0x3a]=1;
  strcpy(b.gyro_align,names[rotation]);gyro_init();CHECK(healthy&&gyro_is_healthy());
  float bias[3]={0,0,0},scale[3]={1,1,1};
  uint32_t current_binding=gyro_accel_calibration_binding(),old_binding=legacy_binding();
  CHECK(current_binding!=0);
  CHECK(gyro_accel_restore_valid(bias,scale,current_binding));
  if(rotation==0||rotation==3) {
   CHECK(current_binding==old_binding);
   CHECK(!gyro_accel_legacy_orientation_valid(bias,scale,old_binding));
  } else {
   CHECK(current_binding!=old_binding);CHECK(!gyro_accel_restore_valid(bias,scale,old_binding));
   CHECK(gyro_accel_legacy_orientation_valid(bias,scale,old_binding));
   CHECK(!gyro_accel_legacy_orientation_valid(bias,scale,current_binding));
   CHECK(!gyro_accel_legacy_orientation_valid(bias,scale,old_binding^0x100u));
   float invalid_scale[3]={NAN,1,1};
   CHECK(!gyro_accel_legacy_orientation_valid(bias,invalid_scale,old_binding));
  }
  val(0x3B,2048);val(0x3D,1024);val(0x3F,4096);
  val(0x43,164);val(0x45,-328);val(0x47,492);
  float d[3];now++;CHECK(gyro_sample(d));
  for(unsigned axis=0;axis<3;axis++) {
   CHECK(fabsf(d[axis]-expected_g[rotation][axis])<.01f);
   CHECK(fabsf(gyro_accel_g()[axis]-expected_a[rotation][axis])<.0001f);
   CHECK(fabsf(gyro_diagnostics()->raw_acc_g[axis]-expected_a[rotation][axis])<.0001f);
  }
  /* A repeated register sample must not double-rotate cached data. */
  uint32_t seq=gyro_diagnostics()->sample_seq;regs[0x3a]=0;now++;
  CHECK(gyro_sample(d));CHECK(gyro_diagnostics()->sample_seq==seq);
  for(unsigned axis=0;axis<3;axis++)CHECK(fabsf(d[axis]-expected_g[rotation][axis])<.01f);
  /* Board configuration is immutable until reinit: no per-sample reparsing. */
  strcpy(b.gyro_align,names[(rotation+1)%4]);regs[0x3a]=1;now++;
  CHECK(gyro_sample(d));
  for(unsigned axis=0;axis<3;axis++)CHECK(fabsf(d[axis]-expected_g[rotation][axis])<.01f);
 }
 const char *bad[]={"BROKEN","CW45_DEG","CW0_DEG_FLIP","CW270_DEG_FLIP"};
 for(unsigned i=0;i<4;i++) {
  strcpy(b.gyro_align,bad[i]);gyro_init();CHECK(!healthy&&!gyro_is_healthy());
  float d[3]={1,2,3};CHECK(!gyro_sample(d));CHECK(d[0]==0&&d[1]==0&&d[2]==0);
 }
 strcpy(b.gyro_align, "");gyro_init();
#if BOBFLIGHT_HOST
 CHECK(healthy && gyro_is_healthy()); /* Explicit legacy host-fixture compatibility. */
#else
 CHECK(!healthy && !gyro_is_healthy()); /* No implicit physical mounting. */
#endif
 puts("PASS: driver-level four-orientation golden vectors, gyro/accel agreement, cached freshness, initialization-only mapping and invalid-alignment rejection");
 return 0;
}
