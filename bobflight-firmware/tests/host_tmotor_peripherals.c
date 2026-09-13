/* SPDX-License-Identifier: Apache-2.0
 * Links REAL F7 motor/ADC/unsupported-flash drivers, not the host HAL.
 * No MMIO is permitted while testing the unported target's public entry points.
 */
#include "board/board.h"
#include "hal/stm32f7/hal_f7_priv.h"
#include <assert.h>
#include <stdio.h>
static board_t b={.board_id="tmotor_f7_v2"};
uint32_t SystemCoreClock=168000000;
const board_t *board_get(void){return &b;}
bool board_mmio_permitted(void){return true;} /* even an allowed, identified MCU */
bool hal_gpio_configure(hal_pin_t pin,const hal_gpio_cfg_t *cfg){(void)pin;(void)cfg;assert(0 && "unexpected GPIO setup");return false;}
void hal_f7_rcc_gpio_enable(unsigned port){(void)port;assert(0 && "unexpected GPIO clock");}
hal_f7_gpio_regs_t *hal_f7_gpio(unsigned port){(void)port;assert(0 && "unexpected GPIO pointer");return NULL;}
uint32_t hal_millis(void){assert(0 && "ADC must not start a cycle");return 0;}
void __DMB(void){} /* disabled motor path never reaches a burst */
int main(void){
 const hal_pin_t pins[]={HAL_PIN_PACK(1,0),HAL_PIN_PACK(1,1),HAL_PIN_PACK(1,4),HAL_PIN_PACK(1,5),HAL_PIN_PACK(4,9),HAL_PIN_PACK(4,11)};
 const unsigned tim[]={3,3,3,3,1,1},ch[]={3,4,1,2,1,2};
 for(unsigned i=0;i<6;i++){
  hal_tim_dma_cfg_t cfg={0};cfg.pin=pins[i];cfg.tim=tim[i];cfg.channel=ch[i];cfg.bit_hz=300000;
  assert(hal_tim_dma_open_cfg(&cfg)==NULL);
 }
 assert(hal_tim_dma_open(3,3)==NULL);
 assert(!hal_tim_dma_start_burst(NULL,NULL,0));
 assert(hal_tim_dma_set_bit_rate(600000)); /* no initialized timer => RAM setting only */
 assert(!hal_tim_dma_set_bit_rate(123));
 hal_power_adc_init(HAL_PIN_PACK(2,2),HAL_PIN_PACK(2,3));
 uint16_t v=123,c=456;assert(!hal_power_adc_poll(&v,&c)&&v==123&&c==456);
 /* Even a mistaken Kakute pin pair must not initialize ADC on this board. */
 hal_power_adc_init(HAL_PIN_PACK(2,3),HAL_PIN_PACK(2,2));assert(!hal_power_adc_poll(&v,&c));
 assert(!hal_flash_supported());assert(!hal_flash_erase_slot(0));
 char data[4]={1,2,3,4};assert(!hal_flash_read(0,data,sizeof(data)));assert((unsigned char)data[0]==255); /* unsupported backend fills erased bytes but returns false */
 assert(!hal_flash_write(0,data,sizeof(data)));
 puts("PASS real F7 HAL: TMOTOR motor binding and bursts unavailable, ADC never starts, flash read/write/erase refused");
}
