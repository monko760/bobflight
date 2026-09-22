/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * F745 SPI1 SD backend; gyro's SPI4 bus/state is never reused.
 * At PCLK2=108MHz SPI /256 is 421.875kHz, too fast for SD initialization.
 * Therefore initialize with bounded GPIO edges (>=3us half-period), then use
 * SPI1 AF5 at <=25MHz. No global clock changes, delays, or wait loops. */
#include "sd_spi_hw.h"
#include "board/board.h"
#include "hal_f7_priv.h"
#include <string.h>
typedef struct {volatile uint32_t CR1,CR2,SR,DR;} sd_regs_t;
#ifdef BOBFLIGHT_SD_SPI_HW_TEST
static sd_regs_t test_regs;
static uint32_t test_clock_enable;
#define SD_REGS (&test_regs)
#define SD_CLOCK_ENABLE test_clock_enable
#define SD_PCLK 108000000u
#else
#define SD_REGS ((sd_regs_t *)(uintptr_t)0x40013000u)
#define SD_CLOCK_ENABLE (HAL_F7_RCC->APB2ENR)
#define SD_PCLK hal_f7_pclk(true)
#endif
static struct {
 const board_t *board;
 bool bound,slow,active,error,sent,received,rising;
 uint8_t tx,rx,bit;
 uint64_t started,next_edge;
} hw;
static void chip_select(bool selected,void *ctx){
 (void)ctx;if(hw.bound)hal_gpio_write(hw.board->sd_cs_pin,!selected);
}
static void speed(sd_spi_speed_t mode,void *ctx){
 (void)ctx;if(!hw.bound)return;
 hw.error=false;hw.active=false;hw.slow=mode==SD_SPI_SPEED_SLOW;
 SD_REGS->CR1=0;
 const board_t *b=hw.board;
 if(hw.slow){
  hal_gpio_cfg_t out={HAL_GPIO_OUT,HAL_GPIO_PULL_NONE,HAL_GPIO_SPEED_MED,0};
  hal_gpio_cfg_t in={HAL_GPIO_IN,HAL_GPIO_PULL_UP,HAL_GPIO_SPEED_MED,0};
  hw.error=!hal_gpio_configure(b->sd_sck_pin,&out)||!hal_gpio_configure(b->sd_mosi_pin,&out)||!hal_gpio_configure(b->sd_miso_pin,&in);
  hal_gpio_write(b->sd_sck_pin,false);hal_gpio_write(b->sd_mosi_pin,true);
 }else{
  hal_gpio_cfg_t af={HAL_GPIO_AF,HAL_GPIO_PULL_UP,HAL_GPIO_SPEED_VERYHIGH,5};
  hw.error=!hal_gpio_configure(b->sd_sck_pin,&af)||!hal_gpio_configure(b->sd_mosi_pin,&af)||!hal_gpio_configure(b->sd_miso_pin,&af);
  uint32_t hz=SD_PCLK/2u;unsigned br=0;
  while(hz>25000000u&&br<7u){hz/=2u;br++;} /* <=7 arithmetic steps, no waiting */
  if(!hz||hz>25000000u){hw.error=true;return;}
  SD_REGS->CR2=(7u<<8)|(1u<<12);
  SD_REGS->CR1=(1u<<2)|(br<<3)|(1u<<8)|(1u<<9)|(1u<<6); /* mode0, 8bit, software NSS */
 }
}
static void exchange_start(uint8_t byte,void *ctx){
 (void)ctx;if(!hw.bound||hw.error)return;
 if(hw.active){hw.error=true;return;}
 hw.active=true;hw.tx=byte;hw.rx=0;hw.bit=0;hw.sent=false;hw.received=false;hw.rising=true;
 hw.started=hal_micros();hw.next_edge=hw.started+3u;
 if(hw.slow){hal_gpio_write(hw.board->sd_sck_pin,false);hal_gpio_write(hw.board->sd_mosi_pin,(byte&128u)!=0);}
}
static sd_spi_io_status_t exchange_poll(uint8_t *rx,void *ctx){
 (void)ctx;if(!rx||!hw.bound||hw.error)return SD_SPI_IO_ERROR;
 if(!hw.active)return SD_SPI_IO_PENDING;
 uint64_t now=hal_micros();
 if(now<hw.started||now-hw.started>2000u){hw.error=true;hw.active=false;return SD_SPI_IO_ERROR;}
 if(hw.slow){
  if(now<hw.next_edge)return SD_SPI_IO_PENDING;
  if(hw.rising){
   hal_gpio_write(hw.board->sd_sck_pin,true);hw.rx=(uint8_t)((hw.rx<<1)|(hal_gpio_read(hw.board->sd_miso_pin)?1u:0u));hw.rising=false;
  }else{
   hal_gpio_write(hw.board->sd_sck_pin,false);hw.bit++;
   if(hw.bit==8u){hw.active=false;*rx=hw.rx;return SD_SPI_IO_DONE;}
   hal_gpio_write(hw.board->sd_mosi_pin,(hw.tx&(128u>>hw.bit))!=0);hw.rising=true;
  }
  hw.next_edge=now+3u;return SD_SPI_IO_PENDING;
 }
 uint32_t sr=SD_REGS->SR;
 if(sr&((1u<<5)|(1u<<6)|(1u<<8))){hw.error=true;return SD_SPI_IO_ERROR;}
 if(!hw.sent){
  if(!(sr&2u))return SD_SPI_IO_PENDING;
  *(volatile uint8_t *)&SD_REGS->DR=hw.tx;hw.sent=true;return SD_SPI_IO_PENDING;
 }
 if(!hw.received){
  if(!(sr&1u))return SD_SPI_IO_PENDING;
  hw.rx=*(volatile uint8_t *)&SD_REGS->DR;hw.received=true;
 }
 if(SD_REGS->SR&(1u<<7))return SD_SPI_IO_PENDING;
 *rx=hw.rx;hw.active=false;return SD_SPI_IO_DONE;
}
bool sd_spi_hw_bind(sd_spi_io_t *io){
 if(!io)return false;
 *io=(sd_spi_io_t){0};
 const board_t *b=board_get();
 if(!b||hw.active||!board_mmio_permitted()||!hal_time_high_resolution()||strcmp(b->mcu_family,"STM32F745")||b->sd_spi_bus!=1u||b->gyro_spi_bus==1u||!hal_pin_valid(b->sd_cs_pin)||!hal_pin_valid(b->sd_sck_pin)||!hal_pin_valid(b->sd_miso_pin)||!hal_pin_valid(b->sd_mosi_pin))return false;
 hw.board=b;hw.bound=true;hw.error=false;hw.active=false;
 SD_CLOCK_ENABLE|=1u<<12;(void)SD_CLOCK_ENABLE;
#ifndef BOBFLIGHT_SD_SPI_HW_TEST
 HAL_F7_RCC->APB2RSTR|=1u<<12;HAL_F7_RCC->APB2RSTR&=~(1u<<12);
#endif
 SD_REGS->CR1=0;
 hal_gpio_cfg_t out={HAL_GPIO_OUT,HAL_GPIO_PULL_UP,HAL_GPIO_SPEED_MED,0};
 hal_gpio_cfg_t input={HAL_GPIO_IN,HAL_GPIO_PULL_UP,HAL_GPIO_SPEED_MED,0};
 if(!hal_gpio_configure(b->sd_cs_pin,&input)){hw.bound=false;return false;}
 /* Set output latch high before switching CS to output, to avoid selecting card. */
 hal_gpio_write(b->sd_cs_pin,true);
 if(!hal_gpio_configure(b->sd_cs_pin,&out)){hw.bound=false;return false;}
 chip_select(false,0);speed(SD_SPI_SPEED_SLOW,0);
 if(hw.error){hw.bound=false;return false;}
 *io=(sd_spi_io_t){chip_select,speed,exchange_start,exchange_poll,0};return true;
}

void sd_spi_hw_cancel(void){
 if(!hw.bound)return;
 SD_REGS->CR1=0;hal_gpio_write(hw.board->sd_cs_pin,true);
 hw.active=false;hw.error=false;hw.bound=false;
}
