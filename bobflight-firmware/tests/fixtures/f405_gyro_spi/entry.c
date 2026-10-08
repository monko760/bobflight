/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "hal/stm32f4/gyro_spi_bridge.h"
#include "drivers/gyro.h"
#include "flight/arming.h"
#include "flight/config.h"
#include "board/board.h"
#include <string.h>
#include <math.h>
volatile uint32_t fixture_case,fixture_phase,fixture_cs,fixture_error,fixture_status;
volatile uint32_t fixture_freeze,fixture_time_fail,fixture_calls,fixture_now,fixture_health;
volatile uint32_t fixture_polls,fixture_elapsed,fixture_sample_seq;
float fixture_gyro[3],fixture_acc[3];
static board_t board;
static bf_f405_spi_bus_t spi;
static uint32_t ms;
__attribute__((noreturn,noinline)) void fixture_done(void) { for(;;)__asm volatile("nop"); }
#define CHECK(x) do {if(!(x)){fixture_error=__LINE__;fixture_done();}}while(0)
bool bf_f405_time_read_us(uint64_t *out) {
 fixture_calls++;
 if(fixture_case==205 || (fixture_phase && fixture_time_fail))return false;
 if(!fixture_phase || !fixture_freeze) fixture_now++;
 *out=(uint64_t)ms*1000u+fixture_now;return true;
}
uint32_t hal_millis(void){return ms;}
void hal_delay_ms(uint32_t n){ms+=n;}
bool hal_usb_cdc_connected(void){return true;}
arm_state_t arming_state(void){return ARM_DISARMED;}
void arming_set_gyro_healthy(bool healthy){fixture_health=healthy;}
const board_t *board_get(void){return &board;}
bool board_pins_live(void){return true;}
bool board_mmio_permitted(void){return true;}
bool hal_exti_attach(hal_pin_t p,hal_exti_cb_t cb,void *ctx){(void)p;(void)cb;(void)ctx;return false;}
static void cs(void *ctx,bool selected){(void)ctx;fixture_cs=selected;}
void bf_f4_component_entry(void)
{
 bf_f4_clock_plan_t clocks={.hclk_hz=168000000,.apb2_hz=84000000};
 if(fixture_case>=200) {
  bf_f405_spi_prescaler_t p=fixture_case==201?(bf_f405_spi_prescaler_t)0:BF_F405_SPI_PRESCALER_128;
  if(fixture_case==202)clocks.apb2_hz=42000000;
  if(fixture_case==203)__asm volatile("cpsie i" ::: "memory");
  bf_f405_spi_regs_t *r=fixture_case==204?(bf_f405_spi_regs_t *)0x40013004u:NULL;
  fixture_status=bf_f405_spi_init(&spi,r,&clocks,p);CHECK(fixture_status!=0);
  fixture_done();
 }
 CHECK(bf_f405_spi_init(&spi,NULL,&clocks,BF_F405_SPI_PRESCALER_128)==BF_F405_SPI_OK);
 CHECK(bf_f405_spi_init(&spi,NULL,&clocks,BF_F405_SPI_PRESCALER_128)==BF_F405_SPI_ERR_ALREADY);
 CHECK(bf_f405_spi_set_cs_callback(&spi,cs,NULL)==BF_F405_SPI_OK);
 CHECK(bf_f405_spi_set_timeouts(&spi,128,500)==BF_F405_SPI_OK);
 /* Prove runtime calls work with USB/tick interrupts enabled and preserve it. */
 __asm volatile("cpsie i" ::: "memory");
 fixture_phase=1;
 if(fixture_case>=100) {
  uint8_t tx[2]={0xf5,0},rx[2]={0,0};
  CHECK(bf_f405_spi_transfer(&spi,tx,rx,0)==BF_F405_SPI_ERR_INVALID);
  CHECK(bf_f405_spi_transfer(&spi,tx,rx,65)==BF_F405_SPI_ERR_INVALID);
  CHECK(bf_f405_spi_set_prescaler(&spi,(bf_f405_spi_prescaler_t)0)==BF_F405_SPI_ERR_INVALID);
  if(fixture_case==101) CHECK(bf_f405_spi_set_timeouts(&spi,8,500)==BF_F405_SPI_OK);
  if(fixture_case==102) CHECK(bf_f405_spi_set_timeouts(&spi,128,3)==BF_F405_SPI_OK);
  fixture_status=bf_f405_spi_transfer(&spi,tx,rx,2);
  fixture_polls=spi.last_polls;fixture_elapsed=spi.last_elapsed_us;
  CHECK(!fixture_cs);
  if(fixture_status) {
   CHECK(spi.in_error && !bf_f405_spi_is_ready(&spi));
   CHECK(bf_f405_spi_transfer(&spi,tx,rx,2)==fixture_status);
  } else {
   CHECK(rx[1]==0x68);
   CHECK(bf_f405_spi_set_prescaler(&spi,BF_F405_SPI_PRESCALER_256)==BF_F405_SPI_OK);
   CHECK(spi.prescaler==BF_F405_SPI_PRESCALER_256);
  }
  fixture_done();
 }
 strcpy(board.board_id,"mltempf4");strcpy(board.mcu_family,"STM32F405");
 strcpy(board.gyro_chip,"MPU6000");strcpy(board.gyro_align,"CW180_DEG");
 board.gyro_spi_bus=1;board.gyro_cs_pin=HAL_PIN_PACK(0,4);
 board.gyro_sck_pin=HAL_PIN_PACK(0,5);board.gyro_miso_pin=HAL_PIN_PACK(0,6);board.gyro_mosi_pin=HAL_PIN_PACK(0,7);
 board.gyro_exti_pin=HAL_PIN_PACK(2,5);
 CHECK(bf_f405_gyro_spi_bind(&spi,board.gyro_cs_pin));
 CHECK(!bf_f405_gyro_spi_bind(&spi,board.gyro_cs_pin));
 CHECK(!hal_spi_open(2)); CHECK(!hal_spi_open_cfg(NULL));
 hal_spi_bus_t *bus=hal_spi_open(1);CHECK(bus);
 CHECK(hal_spi_set_hz(bus,20000000u)==656250u);
 CHECK(hal_spi_set_hz(bus,100u)==0);
 CHECK(!hal_spi_transfer(bus,HAL_PIN_PACK(0,3),NULL,NULL,1));
 CHECK(!hal_spi_transfer(bus,board.gyro_cs_pin,NULL,NULL,18));
 config_init();gyro_init();
 if(fixture_case==1 || fixture_case==2) {
  CHECK(!fixture_health && !gyro_is_healthy());fixture_done();
 }
 CHECK(fixture_health && gyro_is_healthy());
 CHECK(gyro_diagnostics()->config_ok && gyro_diagnostics()->odr_hz==1000);
 fixture_phase=2;ms++;
 bool ok=gyro_sample(fixture_gyro);
 if(fixture_case==3) {
  CHECK(!ok && !fixture_health && !gyro_is_healthy());CHECK(spi.in_error && !fixture_cs);fixture_done();
 }
 CHECK(ok);
 memcpy(fixture_acc,gyro_accel_g(),sizeof(fixture_acc));
 CHECK(fabsf(fixture_gyro[0]+10)<.01f && fabsf(fixture_gyro[1]-20)<.01f && fabsf(fixture_gyro[2]-30)<.01f);
 CHECK(fabsf(fixture_acc[0]+.5f)<.001f && fabsf(fixture_acc[1]+.25f)<.001f && fabsf(fixture_acc[2]-1)<.001f);
 fixture_sample_seq=gyro_diagnostics()->sample_seq;CHECK(fixture_sample_seq==1);
 fixture_phase=3;ms++;
 CHECK(gyro_sample(fixture_gyro));CHECK(gyro_diagnostics()->sample_seq==fixture_sample_seq);
 ms+=21;CHECK(!gyro_sample(fixture_gyro));CHECK(gyro_diagnostics()->sample_seq==fixture_sample_seq);
 CHECK(!fixture_cs);fixture_done();
}
