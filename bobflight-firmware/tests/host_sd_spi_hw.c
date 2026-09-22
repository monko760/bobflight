/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#define BOBFLIGHT_SD_SPI_HW_TEST 1
#include "../src/hal/stm32f7/sd_spi_hw.c"
#include <assert.h>
#include <stdio.h>
static board_t board;
static bool allowed=true,highres=true,gpio_ok=true;
static uint64_t now;
static uint8_t input_byte;static unsigned input_bit,writes,configs;
static bool levels[256];
const board_t *board_get(void){return &board;}
bool board_mmio_permitted(void){return allowed&&!board.is_dummy;}
bool hal_time_high_resolution(void){return highres;}
uint64_t hal_micros(void){return now;}
bool hal_gpio_configure(hal_pin_t pin,const hal_gpio_cfg_t *cfg){assert(pin==board.sd_cs_pin||pin==board.sd_sck_pin||pin==board.sd_miso_pin||pin==board.sd_mosi_pin);assert(cfg);configs++;return gpio_ok;}
void hal_gpio_write(hal_pin_t pin,bool high){assert(pin==board.sd_cs_pin||pin==board.sd_sck_pin||pin==board.sd_mosi_pin);levels[pin]=high;writes++;}
bool hal_gpio_read(hal_pin_t pin){assert(pin==board.sd_miso_pin&&input_bit<8);return (input_byte&(128u>>input_bit++))!=0;}
int main(void){
 strcpy(board.mcu_family,"STM32F745");board.sd_spi_bus=1;board.gyro_spi_bus=4;board.sd_cs_pin=HAL_PIN_PACK(0,4);board.sd_sck_pin=HAL_PIN_PACK(0,5);board.sd_miso_pin=HAL_PIN_PACK(0,6);board.sd_mosi_pin=HAL_PIN_PACK(0,7);
 sd_spi_io_t io;allowed=false;assert(!sd_spi_hw_bind(&io)&&!configs);allowed=true;highres=false;assert(!sd_spi_hw_bind(&io)&&!configs);highres=true;
 board.gyro_spi_bus=1;assert(!sd_spi_hw_bind(&io)&&!configs);board.gyro_spi_bus=4;assert(sd_spi_hw_bind(&io));assert(levels[board.sd_cs_pin]);
 input_byte=0xa5;uint8_t rx=0;io.spi_start_exchange(0x96,io.user_ctx);assert(!sd_spi_hw_bind(&(sd_spi_io_t){0}));
 for(unsigned edge=0;edge<16;edge++){
  unsigned before=writes;assert(io.spi_poll_exchange(&rx,io.user_ctx)==SD_SPI_IO_PENDING);assert(writes==before);
  now+=3;sd_spi_io_status_t st=io.spi_poll_exchange(&rx,io.user_ctx);assert(st==(edge==15?SD_SPI_IO_DONE:SD_SPI_IO_PENDING));
 }
 assert(rx==0xa5&&input_bit==8&&now==48&&!levels[board.sd_sck_pin]);
 io.set_speed(SD_SPI_SPEED_FAST,io.user_ctx);assert(((test_regs.CR1>>3)&7)==2);assert((108000000u/2u/(1u<<2))==13500000u);
 test_regs.SR=0;io.spi_start_exchange(0x5a,io.user_ctx);assert(io.spi_poll_exchange(&rx,io.user_ctx)==SD_SPI_IO_PENDING);
 test_regs.SR=2;assert(io.spi_poll_exchange(&rx,io.user_ctx)==SD_SPI_IO_PENDING);assert((test_regs.DR&255)==0x5a);
 test_regs.DR=0x3c;test_regs.SR=1|2|128;assert(io.spi_poll_exchange(&rx,io.user_ctx)==SD_SPI_IO_PENDING);test_regs.SR=2;assert(io.spi_poll_exchange(&rx,io.user_ctx)==SD_SPI_IO_DONE&&rx==0x3c);
 io.spi_start_exchange(0xff,io.user_ctx);now+=2001;assert(io.spi_poll_exchange(&rx,io.user_ctx)==SD_SPI_IO_ERROR);
 assert(sd_spi_hw_bind(&io));gpio_ok=false;io.set_speed(SD_SPI_SPEED_FAST,io.user_ctx);assert(io.spi_poll_exchange(&rx,io.user_ctx)==SD_SPI_IO_ERROR);
 puts("PASS SD F745 backend: target/clock guards; >=3us GPIO half-clock; byte waits yield; 13.5MHz SPI1; BSY completion; timeout/config failures; no gyro pins touched");
}
