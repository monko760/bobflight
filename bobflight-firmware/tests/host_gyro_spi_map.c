/* SPDX-License-Identifier: Apache-2.0 */
#include "hal/stm32f7/gyro_spi_map.h"
#include <assert.h>
#include <stdio.h>
static board_t make_board(bool tmotor){
 board_t b={0};strcpy(b.board_id,tmotor?"tmotor_f7_v2":"kakute_f7_hdv");
 b.gyro_spi_bus=tmotor?1:4;
 b.gyro_cs_pin=tmotor?HAL_PIN_PACK(0,4):HAL_PIN_PACK(4,4);
 b.gyro_sck_pin=tmotor?HAL_PIN_PACK(0,5):HAL_PIN_PACK(4,2);
 b.gyro_miso_pin=tmotor?HAL_PIN_PACK(0,6):HAL_PIN_PACK(4,5);
 b.gyro_mosi_pin=tmotor?HAL_PIN_PACK(0,7):HAL_PIN_PACK(4,6);
 return b;
}
int main(void){
 for(unsigned t=0;t<2;t++){
  board_t b=make_board(t!=0);uintptr_t base=0;uint32_t en=0;
  assert(gyro_spi_map(&b,b.gyro_spi_bus,&base,&en));
  assert(base==(t?0x40013000u:0x40013400u));assert(en==(1u<<(t?12:13)));
  for(unsigned index=0;index<8;index++)if(index!=b.gyro_spi_bus)assert(!gyro_spi_map(&b,index,&base,&en));
  for(unsigned p=0;p<4;p++){
   board_t bad=b;hal_pin_t *pins[]={&bad.gyro_cs_pin,&bad.gyro_sck_pin,&bad.gyro_miso_pin,&bad.gyro_mosi_pin};
   *pins[p]=HAL_PIN_INVALID;assert(!gyro_spi_map(&bad,bad.gyro_spi_bus,&base,&en));
  }
  strcpy(b.board_id,"unknown");assert(!gyro_spi_map(&b,b.gyro_spi_bus,&base,&en));
 }
 uintptr_t base;uint32_t en;
 assert(!gyro_spi_map(NULL,1,&base,&en));
 puts("PASS actual gyro SPI selector: F722 SPI1, F745 SPI4, invalid pins/index/board refused");
}
