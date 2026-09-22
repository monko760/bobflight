/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Exercise the actual F7 GPIO + SD hardware backend, not a replacement
 * hal_gpio_read stub. The private-header guard keeps CMSIS off the host while
 * the production GPIO MMIO code operates on simulated register structures. */
#include "hal/stm32f7/hal_f7_priv.h"
#define BOBFLIGHT_HAVE_CMSIS 1
#include "../src/hal/stm32f7/hal_gpio.c"
#define BOBFLIGHT_SD_SPI_HW_TEST 1
#include "../src/hal/stm32f7/sd_spi_hw.c"
#include <assert.h>
#include <stdio.h>
static hal_f7_gpio_regs_t gpio_bank[11];
static board_t board;
static bool allowed=true;
static uint64_t now;
static unsigned register_reads;
bool hal_f7_pin_decode(hal_pin_t pin,unsigned *port,unsigned *num){
 if(!hal_pin_valid(pin)||HAL_PIN_PORT(pin)>=11)return false;
 *port=HAL_PIN_PORT(pin);*num=HAL_PIN_NUM(pin);return true;
}
bool hal_f7_mmio_ok(hal_pin_t pin,unsigned *port,unsigned *num){return allowed&&hal_f7_pin_decode(pin,port,num);}
void hal_f7_rcc_gpio_enable(unsigned port){assert(port<11);}
hal_f7_gpio_regs_t *hal_f7_gpio(unsigned port){register_reads++;return port<11?&gpio_bank[port]:NULL;}
const board_t *board_get(void){return &board;}
bool board_mmio_permitted(void){return allowed;}
bool hal_time_high_resolution(void){return true;}
uint64_t hal_micros(void){return now;}
int main(int argc,char **argv){
 (void)argv;
 const hal_pin_t miso=HAL_PIN_PACK(0,6);
 hal_gpio_cfg_t in={HAL_GPIO_IN,HAL_GPIO_PULL_UP,HAL_GPIO_SPEED_MED,0};
 if(argc==1){
  assert(hal_gpio_configure(miso,&in));
  gpio_bank[0].IDR=1u<<6;assert(hal_gpio_read(miso)); /* Cached level is false. */
  hal_gpio_write(miso,true);gpio_bank[0].IDR=0;assert(!hal_gpio_read(miso)); /* Cached level is true. */
  unsigned before=register_reads;assert(!hal_gpio_read(HAL_PIN_INVALID));assert(register_reads==before);
  allowed=false;assert(hal_gpio_read(miso));assert(register_reads==before);allowed=true;
  puts("PASS real F7 GPIO: external high/low overrides cached output; invalid and MMIO-denied guards preserved");
 }
 memset(g_slots,0,sizeof g_slots);memset(gpio_bank,0,sizeof gpio_bank);
 strcpy(board.mcu_family,"STM32F745");board.sd_spi_bus=1;board.gyro_spi_bus=4;
 board.sd_cs_pin=HAL_PIN_PACK(0,4);board.sd_sck_pin=HAL_PIN_PACK(0,5);board.sd_miso_pin=miso;board.sd_mosi_pin=HAL_PIN_PACK(0,7);
 sd_spi_io_t io;assert(sd_spi_hw_bind(&io));sd_spi_t card;sd_spi_init_ctx(&card,&io);assert(sd_spi_begin_init(&card,now)==SD_SPI_OK);
 sd_spi_status_t st=SD_SPI_ERR_BUSY;
 for(unsigned i=0;i<4000&&st==SD_SPI_ERR_BUSY&&card.substate!=SUB_INIT_CMD8_SEND;i++){
  /* Simulated card returns R1=0x01 for CMD0, with idle-high bytes otherwise.
   * Deliver bits through IDR, exactly where the MCU samples MISO. */
  uint8_t byte=card.substate==SUB_INIT_CMD0_RESP?0x01:0xff;
  gpio_bank[0].IDR=(byte&(128u>>hw.bit))?(1u<<6):0;
  now+=3;st=sd_poll(&card,now);
 }
 printf("CMD0 via real GPIO/backend: error=%u, reached_CMD8=%u\n",(unsigned)card.last_error,card.substate==SUB_INIT_CMD8_SEND);fflush(stdout);
 assert(st==SD_SPI_ERR_BUSY&&card.substate==SUB_INIT_CMD8_SEND);
 sd_spi_hw_cancel();
 puts("PASS real GPIO/SD integration: CMD0 R1 input decoded; initialization advances to CMD8 rather than error 8");
}
