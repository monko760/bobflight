/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Gyro sanity (S3): real gyro.c + real arming.c against an MPU6000-class
 * register mock. Stuck (armed only, >50 ms), periodic WHO_AM_I / config
 * readback, latch until re-init, saturation counter, bounded SPI work,
 * register clock for config reads, and the status lines (gyro_ok no on any
 * non-ok health). */
#include "drivers/gyro.h"
#include "flight/arming.h"
#include "board/board.h"
#include "hal/hal.h"
#include <stdio.h>
#include <stdint.h>
#include <string.h>
static uint32_t now;
uint32_t hal_millis(void){return now;}
bool hal_usb_cdc_connected(void){return true;}
static board_t b;static unsigned char regs[128];static bool broken;
const board_t *board_get(void){return &b;}
bool board_pins_live(void){return true;}bool board_mmio_permitted(void){return false;}
/* arming.c dependencies: link healthy, throttle low. */
bool failsafe_active(void){return false;}
static const float rc[16];
const float *rx_channels(void){return rc;}
bool arming_rate_only(void){return true;}
static bool spi_fast;static unsigned transfers,fast_config_reads,spi_set_calls;
hal_spi_bus_t *hal_spi_open(unsigned n){spi_fast=false;return n==4?(hal_spi_bus_t*)&b:0;}
bool hal_exti_attach(hal_pin_t p,hal_exti_cb_t cb,void *ctx){(void)p;(void)cb;(void)ctx;return false;}
void hal_delay_ms(uint32_t ms){(void)ms;}
uint32_t hal_spi_set_hz(hal_spi_bus_t *bus,uint32_t max_hz){(void)bus;spi_set_calls++;spi_fast=max_hz>1000000u;return spi_fast?13500000u:843750u;}
bool hal_spi_transfer(hal_spi_bus_t *bus,hal_pin_t cs,const uint8_t *tx,uint8_t *rx,size_t n){
 (void)bus;(void)cs;transfers++;if(broken)return false;memset(rx,0,n);
 if(tx[0]&128){
  const unsigned reg=tx[0]&127u;
  /* PS-MPU-6000A-00: only sensor/interrupt registers (0x3A..0x48) may be read above 1 MHz. */
  if(spi_fast&&(reg<0x3Au||reg>0x48u))fast_config_reads++;
  for(size_t i=1;i<n;i++)rx[i]=regs[reg+i-1];
 } else if(n==2)regs[tx[0]]=tx[1];
 return true;
}
static void raw(int x,int y,int z){unsigned a=0x43;int v[3]={x,y,z};for(unsigned i=0;i<3;i++){regs[a]=(unsigned)v[i]>>8;regs[a+1]=(unsigned char)v[i];a+=2;}}
#define CHECK(x) do {if(!(x)){fprintf(stderr,"failed line %d: %s\n",__LINE__,#x);return 1;}} while(0)
static char line[128];
static const char *status(void){if(gyro_status_lines(line,sizeof line)<0)return "overflow";return line;}
static void fresh(const char *board_id){
 memset(regs,0,sizeof regs);broken=false;strcpy(b.board_id,board_id);strcpy(b.gyro_chip,"MPU6000");
 regs[0x75]=0x68;regs[0x3a]=1;arming_init();gyro_init();raw(10,-20,30);
}
/* One fresh sample per ms for `ms` ms; returns false at the first failed sample. */
static bool samples(unsigned ms){float d[3];for(unsigned i=0;i<ms;i++){now++;if(!gyro_sample(d))return false;}return true;}
static bool arm(void){return arming_try_arm()&&arming_state()==ARM_ARMED;}
/* Poll with a full budget every GYRO_HEALTH_PERIOD_MS until the health changes or `n` polls ran. */
static void polls(unsigned n){for(unsigned i=0;i<n&&gyro_health()==GYRO_HEALTH_OK;i++){now+=GYRO_HEALTH_PERIOD_MS;gyro_health_poll(200);}}
int main(void){
 b.gyro_spi_bus=4;b.gyro_cs_pin=HAL_PIN_PACK(4,4);
 fresh("dummy");
 CHECK(gyro_is_healthy()&&gyro_health()==GYRO_HEALTH_OK&&gyro_sat_count()==0);
 CHECK(!strcmp(status(),"gyro_ok: yes\r\ngyro_health: ok\r\ngyro_sat_count: 0\r\n"));
 /* Disarmed bench board: identical raw for 2 s stays ok (detection runs only while armed). */
 CHECK(samples(2000)&&gyro_health()==GYRO_HEALTH_OK&&gyro_is_healthy());
 /* Armed: identical raw on all axes for 50 ms is still ok; >50 ms latches stuck. */
 CHECK(arm());CHECK(samples(1));uint32_t t0=now;CHECK(samples(50)&&now-t0==50&&gyro_health()==GYRO_HEALTH_OK);
 CHECK(!samples(1)&&gyro_health()==GYRO_HEALTH_STUCK&&now-t0==51);
 CHECK(!gyro_is_healthy()&&arming_state()==ARM_DISARMED);          /* existing invalid-gyro disarm path */
 CHECK(!strcmp(status(),"gyro_ok: no\r\ngyro_health: stuck\r\ngyro_sat_count: 0\r\n"));
 /* Latched until reboot: moving data, disarm and polls do not clear it; arming is refused. */
 raw(1,2,3);CHECK(!samples(1));raw(4,5,6);CHECK(!samples(1));polls(10);
 CHECK(gyro_health()==GYRO_HEALTH_STUCK&&!gyro_is_healthy()&&!arm());
 /* Re-init (reboot) clears it. */
 fresh("dummy");CHECK(gyro_health()==GYRO_HEALTH_OK&&gyro_is_healthy());
 /* One axis still moving is not stuck; any change restarts the window. */
 CHECK(arm());for(int i=0;i<200;i++){raw(10,-20,30+(i&1));CHECK(samples(1));}CHECK(gyro_health()==GYRO_HEALTH_OK);
 raw(7,7,7);CHECK(samples(45));raw(7,7,8);CHECK(samples(45));raw(7,7,7);CHECK(samples(45)&&gyro_health()==GYRO_HEALTH_OK);
 /* Disarm restarts the window: 45 ms armed + disarm + 45 ms armed never trips. */
 raw(9,9,9);CHECK(samples(45));arming_disarm();CHECK(samples(1));CHECK(arm());CHECK(samples(45)&&gyro_health()==GYRO_HEALTH_OK);
 /* Data-ready not set: the cached sample is not a new raw sample (no stuck vote). */
 regs[0x3a]=0;{float d[3];for(int i=0;i<20;i++){now++;(void)gyro_sample(d);}}regs[0x3a]=1;raw(1,1,2);CHECK(samples(1)&&gyro_health()==GYRO_HEALTH_OK);
 arming_disarm();
 /* Saturation is counted (any axis at INT16_MAX / INT16_MIN), never disarms, armed or not. */
 raw(32767,0,1);CHECK(samples(3)&&gyro_sat_count()==3);raw(0,-32768,1);CHECK(samples(2)&&gyro_sat_count()==5);
 CHECK(arm());raw(32767,-32768,32767);CHECK(samples(1));raw(32767,-32768,32766);CHECK(samples(1));
 raw(1,2,3);CHECK(samples(1)&&gyro_sat_count()==7&&arming_state()==ARM_ARMED&&gyro_health()==GYRO_HEALTH_OK);
 CHECK(!strcmp(status(),"gyro_ok: yes\r\ngyro_health: ok\r\ngyro_sat_count: 7\r\n"));
 gyro_host_set_sat_count(4294967296ull);CHECK(!strcmp(status(),"gyro_ok: yes\r\ngyro_health: ok\r\ngyro_sat_count: 4294967296\r\n"));
 gyro_host_set_sat_count(UINT64_MAX);CHECK(!strcmp(status(),"gyro_ok: yes\r\ngyro_health: ok\r\ngyro_sat_count: 18446744073709551615\r\n"));
 arming_disarm();
 /* Periodic WHO_AM_I: bounded (one 2-byte transfer per poll), rate-limited, budget-gated. */
 fresh("dummy");unsigned before=transfers;
 gyro_health_poll(GYRO_HEALTH_MIN_BUDGET_US-1u);CHECK(transfers==before);  /* no budget: deferred */
 gyro_health_poll(GYRO_HEALTH_MIN_BUDGET_US);CHECK(transfers==before+1);     /* first check */
 now+=GYRO_HEALTH_PERIOD_MS-1u;gyro_health_poll(200);CHECK(transfers==before+1); /* too soon */
 now+=1u;gyro_health_poll(200);CHECK(transfers==before+2);
 polls(60);CHECK(gyro_health()==GYRO_HEALTH_OK&&gyro_is_healthy());               /* healthy part: never trips */
 regs[0x75]=0x70;polls(6);CHECK(gyro_health()==GYRO_HEALTH_WHOAMI_MISMATCH&&!gyro_is_healthy());
 CHECK(!strcmp(status(),"gyro_ok: no\r\ngyro_health: whoami-mismatch\r\ngyro_sat_count: 0\r\n"));
 regs[0x75]=0x68;polls(12);CHECK(gyro_health()==GYRO_HEALTH_WHOAMI_MISMATCH);   /* latched */
 /* Armed + mismatch takes the invalid-gyro path (disarm). */
 fresh("dummy");CHECK(arm());raw(1,2,3);CHECK(samples(1));regs[0x75]=0x00;polls(6);
 CHECK(gyro_health()==GYRO_HEALTH_WHOAMI_MISMATCH&&arming_state()==ARM_DISARMED&&!samples(1));
 /* A failed check transfer is a fault too. */
 fresh("dummy");broken=true;polls(1);broken=false;CHECK(gyro_health()==GYRO_HEALTH_WHOAMI_MISMATCH);
 /* Lost config: each verified register, one at a time. */
 const unsigned char cfg[][2]={{0x6B,0x40},{0x19,0x07},{0x1A,0x00},{0x1B,0x00},{0x1C,0x00}};
 for(unsigned k=0;k<5;k++){
  fresh("dummy");CHECK(regs[0x6B]==0x01&&regs[0x1A]==3&&regs[0x1B]==0x18&&regs[0x1C]==0x10);
  CHECK(arm());CHECK(samples(1));
  regs[cfg[k][0]]=cfg[k][1];polls(6);
  CHECK(gyro_health()==GYRO_HEALTH_CONFIG_LOST&&!gyro_is_healthy()&&arming_state()==ARM_DISARMED);
  CHECK(!strcmp(status(),"gyro_ok: no\r\ngyro_health: config-lost\r\ngyro_sat_count: 0\r\n"));
 }
 /* 8 kHz gyro (Kakute; S1 runs the chain on every gyro sample): the stuck window is TIME on the
  * ms clock, not a sample count. 8 fresh samples per ms: 50 ms = 400 identical samples stays ok,
  * the first sample in ms 51 latches stuck and takes the invalid-gyro disarm. */
 fresh("kakute_f7_hdv");CHECK(gyro_diagnostics()->odr_hz==8000&&arm());
 {float d[3];now++;CHECK(gyro_sample(d));const uint32_t t8=now;unsigned n8=0;
  for(unsigned ms=0;ms<50;ms++){now++;for(unsigned k=0;k<8;k++){CHECK(gyro_sample(d));n8++;}}
  CHECK(now-t8==50&&n8==400&&gyro_health()==GYRO_HEALTH_OK&&arming_state()==ARM_ARMED);
  now++;CHECK(!gyro_sample(d)&&gyro_health()==GYRO_HEALTH_STUCK&&now-t8==51&&arming_state()==ARM_DISARMED);}
 /* At 8 kHz, 40 ms runs of identical samples (320 samples, far more than 50) separated by a
  * one-LSB change never trip: a sample-count threshold sized for 1 kHz would. */
 fresh("kakute_f7_hdv");CHECK(arm());
 {float d[3];for(unsigned ms=0;ms<400;ms++){now++;raw(10,-20,30+(int)((ms/40u)&1u));for(unsigned k=0;k<8;k++)CHECK(gyro_sample(d));}
  CHECK(gyro_health()==GYRO_HEALTH_OK&&gyro_is_healthy()&&arming_state()==ARM_ARMED);}
 arming_disarm();
 /* 8 kHz board: config/ID reads drop to the 1 MHz register clock and sample reads return to the fast clock. */
 fresh("kakute_f7_hdv");CHECK(gyro_diagnostics()->odr_hz==8000&&regs[0x1A]==0&&spi_fast);
 fast_config_reads=0;spi_set_calls=0;polls(12);CHECK(gyro_health()==GYRO_HEALTH_OK);
 CHECK(fast_config_reads==0&&spi_set_calls==24&&spi_fast);CHECK(samples(5));
 regs[0x1A]=3;polls(12);CHECK(gyro_health()==GYRO_HEALTH_CONFIG_LOST&&fast_config_reads==0);
 /* Polls never touch an unhealthy or unbound gyro (nothing to check / already latched). */
 before=transfers;polls(5);now+=500;gyro_health_poll(200);CHECK(transfers==before);
 /* ICM42688 path: chip-ID check only. */
 memset(regs,0,sizeof regs);strcpy(b.board_id,"dummy");strcpy(b.gyro_chip,"ICM42688");regs[0x75]=0x47;arming_init();gyro_init();
#if defined(BOBFLIGHT_TARGET_TMOTORF7V2) || defined(BOBFLIGHT_TARGET_MATEKF722PX)
 /* This target binds the MPU6000 revision only (gyro.c probe): an ICM ID stays unbound, nothing to check. */
 CHECK(!gyro_is_healthy()&&gyro_health()==GYRO_HEALTH_OK);
#else
 CHECK(gyro_is_healthy());polls(12);CHECK(gyro_health()==GYRO_HEALTH_OK);
 regs[0x75]=0x68;polls(2);CHECK(gyro_health()==GYRO_HEALTH_WHOAMI_MISMATCH&&!gyro_is_healthy());
#endif
 /* No gyro found at init (WHO_AM_I reads 0): the existing invalid-gyro state.
  * The runtime checks have nothing to check, so health stays ok, but gyro_ok
  * must still be no: gyro_ok needs a valid gyro AND ok health. */
 memset(regs,0,sizeof regs);arming_init();gyro_init();
 CHECK(!gyro_is_healthy()&&gyro_health()==GYRO_HEALTH_OK);
 CHECK(!strcmp(status(),"gyro_ok: no\r\ngyro_health: ok\r\ngyro_sat_count: 0\r\n"));
 puts("PASS gyro health: stuck (armed only, >50 ms), WHO_AM_I/config readback, latch, saturation counter, bounded SPI, status lines");
 return 0;
}
