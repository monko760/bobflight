/* SPDX-License-Identifier: Apache-2.0 */
#define BOBFLIGHT_NOR_HW_TEST 1
#include "../src/hal/stm32f7/nor_probe_hw.c"
#include <assert.h>
#include <stdio.h>
static board_t board;static bool allowed=true,highres=true,gpio_ok=true,cs_high;static unsigned configs;static uint64_t now;
const board_t *board_get(void){return &board;}
bool board_mmio_permitted(void){return allowed&&!board.is_dummy;}
bool hal_time_high_resolution(void){return highres;}
uint64_t hal_micros(void){return now;}
bool hal_gpio_configure(hal_pin_t p,const hal_gpio_cfg_t *cfg){assert(p==board.flash_cs_pin||p==board.flash_sck_pin||p==board.flash_miso_pin||p==board.flash_mosi_pin);if(p!=board.flash_cs_pin)assert(cfg->mode==HAL_GPIO_AF&&cfg->af==5);configs++;return gpio_ok;}
void hal_gpio_write(hal_pin_t p,bool high){assert(p==board.flash_cs_pin);cs_high=high;}
int main(void){
 strcpy(board.mcu_family,"STM32F722");board.gyro_spi_bus=1;board.flash_spi_bus=2;board.flash_cs_pin=HAL_PIN_PACK(1,12);board.flash_sck_pin=HAL_PIN_PACK(1,13);board.flash_miso_pin=HAL_PIN_PACK(1,14);board.flash_mosi_pin=HAL_PIN_PACK(2,3);
 nor_probe_io_t io;allowed=false;assert(!nor_probe_hw_bind(&io)&&!configs&&!test_en);allowed=true;highres=false;assert(!nor_probe_hw_bind(&io)&&!configs);highres=true;
 board.flash_spi_bus=0;assert(!nor_probe_hw_bind(&io)&&!configs);board.flash_spi_bus=2;
 board.flash_mosi_pin=HAL_PIN_PACK(1,15);assert(!nor_probe_hw_bind(&io)&&!configs);board.flash_mosi_pin=HAL_PIN_PACK(2,3);
 board.gyro_spi_bus=2;assert(!nor_probe_hw_bind(&io)&&!configs);board.gyro_spi_bus=1;
 assert(nor_probe_hw_bind(&io)&&cs_high&&test_en==(1u<<14));assert(((test_regs.CR1>>3)&7u)==6u);assert(test_regs.CR2==((7u<<8)|(1u<<12)));
 assert(!nor_probe_hw_bind(&(nor_probe_io_t){0}));io.select(true,NULL);assert(!cs_high);
 uint8_t out=0;io.start(0x9f,NULL);test_regs.SR=0;assert(io.poll(&out,NULL)==0);test_regs.SR=2;assert(io.poll(&out,NULL)==0&&(test_regs.DR&255u)==0x9f);
 test_regs.DR=0xef;test_regs.SR=1|128;assert(io.poll(&out,NULL)==0);test_regs.SR=0;assert(io.poll(&out,NULL)==1&&out==0xef);
 io.start(0xff,NULL);now=2000;assert(io.poll(&out,NULL)==-1);io.cancel(NULL);assert(cs_high&&test_regs.CR1==0);
 assert(nor_probe_hw_bind(&io));io.start(0xff,NULL);test_regs.SR=1u<<6;assert(io.poll(&out,NULL)==-1);io.cancel(NULL);assert(cs_high);
 gpio_ok=false;assert(!nor_probe_hw_bind(&io));assert(cs_high);
 puts("PASS F722 SPI2 NOR model: AF5 PC3 MOSI, APB1 bit14, <=500kHz, no gyro/other pins, unsupported guards, yield/BSY/error/timeout cleanup");
}
