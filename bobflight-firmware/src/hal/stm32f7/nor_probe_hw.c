/* SPDX-License-Identifier: Apache-2.0. F722 SPI2 read-only flash discovery.
 * Peripheral facts: ST RM0431. Board pins come from owned board IR. */
#include "hal/nor_probe_hw.h"
#include "board/board.h"
#include "hal_f7_priv.h"
#include <string.h>
typedef struct {volatile uint32_t CR1,CR2,SR,DR;} nor_regs_t;
#ifdef BOBFLIGHT_NOR_HW_TEST
static nor_regs_t test_regs;static uint32_t test_en;
#define REGS (&test_regs)
#define CLOCK_EN test_en
#define PCLK 42000000u
#else
#define REGS ((nor_regs_t *)(uintptr_t)0x40003800u)
#define CLOCK_EN HAL_F7_RCC->APB1ENR
#define PCLK hal_f7_pclk(false)
#endif
static struct {const board_t *b;bool bound,active,sent,received,error;uint8_t tx,rx;uint64_t started;} hw;
static void select_chip(bool select,void *ctx){(void)ctx;if(hw.bound)hal_gpio_write(hw.b->flash_cs_pin,!select);}
static void cancel_io(void *ctx){(void)ctx;if(!hw.bound)return;hal_gpio_write(hw.b->flash_cs_pin,true);REGS->CR1=0;hw.bound=false;hw.active=false;hw.error=false;}
static void start_byte(uint8_t tx,void *ctx){
 (void)ctx;if(!hw.bound||hw.active){hw.error=true;return;}
 hw.active=true;hw.tx=tx;hw.sent=hw.received=false;hw.started=hal_micros();
}
static int poll_byte(uint8_t *rx,void *ctx){
 (void)ctx;if(!rx||!hw.bound||hw.error||!hw.active)return -1;
 uint64_t now=hal_micros();if(now<hw.started||now-hw.started>=2000u){hw.error=true;return -1;}
 uint32_t sr=REGS->SR;if(sr&((1u<<5)|(1u<<6)|(1u<<8))){hw.error=true;return -1;}
 if(!hw.sent){if(!(sr&2u))return 0;*(volatile uint8_t *)&REGS->DR=hw.tx;hw.sent=true;return 0;}
 if(!hw.received){if(!(sr&1u))return 0;hw.rx=*(volatile uint8_t *)&REGS->DR;hw.received=true;}
 if(REGS->SR&(1u<<7))return 0;
 *rx=hw.rx;hw.active=false;return 1;
}
bool nor_probe_hw_bind(nor_probe_io_t *io){
 if(!io)return false;
 *io=(nor_probe_io_t){0};const board_t *b=board_get();
 if(hw.bound||!b||!board_mmio_permitted()||!hal_time_high_resolution()||strcmp(b->mcu_family,"STM32F722")||b->flash_spi_bus!=2u||b->gyro_spi_bus==2u||b->sd_spi_bus==2u)return false;
 /* Only the implemented AF5 SPI2 routing is accepted. No guessed pin fallback. */
 if(b->flash_sck_pin!=HAL_PIN_PACK(1u,13u)||b->flash_miso_pin!=HAL_PIN_PACK(1u,14u)||b->flash_mosi_pin!=HAL_PIN_PACK(2u,3u)||b->flash_cs_pin!=HAL_PIN_PACK(1u,12u))return false;
 uint32_t hz=PCLK/2u;unsigned br=0;while(hz>500000u&&br<7u){hz/=2u;br++;}
 if(!hz||hz>500000u)return false;
 memset(&hw,0,sizeof hw);hw.b=b;hw.bound=true;
 hal_gpio_cfg_t input={HAL_GPIO_IN,HAL_GPIO_PULL_UP,HAL_GPIO_SPEED_MED,0};
 hal_gpio_cfg_t output={HAL_GPIO_OUT,HAL_GPIO_PULL_UP,HAL_GPIO_SPEED_MED,0};
 hal_gpio_cfg_t af={HAL_GPIO_AF,HAL_GPIO_PULL_NONE,HAL_GPIO_SPEED_MED,5};
 if(!hal_gpio_configure(b->flash_cs_pin,&input)){hw.bound=false;return false;}
 hal_gpio_write(b->flash_cs_pin,true);
 if(!hal_gpio_configure(b->flash_cs_pin,&output)){hw.bound=false;return false;}
 CLOCK_EN|=1u<<14;(void)CLOCK_EN;
#ifndef BOBFLIGHT_NOR_HW_TEST
 HAL_F7_RCC->APB1RSTR|=1u<<14;HAL_F7_RCC->APB1RSTR&=~(1u<<14);
#endif
 REGS->CR1=0;
 if(!hal_gpio_configure(b->flash_sck_pin,&af)||!hal_gpio_configure(b->flash_miso_pin,&af)||!hal_gpio_configure(b->flash_mosi_pin,&af)){cancel_io(NULL);return false;}
 REGS->CR2=(7u<<8)|(1u<<12); /* 8-bit transfers, quarter FIFO threshold */
 REGS->CR1=(1u<<2)|(br<<3)|(1u<<8)|(1u<<9)|(1u<<6); /* mode0, software NSS */
 *io=(nor_probe_io_t){select_chip,start_byte,poll_byte,cancel_io,NULL};return true;
}
