/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0
 * Actual F7 UART ISR/ring -> shared CRSF parser -> shared receiver in a host
 * register model. mmap here is ordinary process RAM, never physical MMIO.
 * Does not measure hardware timing, pin voltage or interrupt latency. */
#define _GNU_SOURCE
#include <assert.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include "board/board.h"
#include "drivers/rx.h"
#include "drivers/crsf.h"
typedef int IRQn_Type;
static unsigned enabled_irq, gpio_calls;
static hal_pin_t pins[2];
static void NVIC_DisableIRQ(IRQn_Type n){(void)n;}
static void NVIC_ClearPendingIRQ(IRQn_Type n){(void)n;}
static void NVIC_SetPriority(IRQn_Type n,unsigned p){(void)n;assert(p==2);}
static void NVIC_EnableIRQ(IRQn_Type n){enabled_irq=(unsigned)n;}
static void __DMB(void){}
#include "hal/stm32f7/hal_uart.c"
static board_t board={.board_id="matek_f722_px",.rx_uart=2,.rx_pin=HAL_PIN_PACK(0,3),.tx_pin=HAL_PIN_PACK(0,2),.rx_protocol="CRSF"};
static uint32_t now;static unsigned accepted;
const board_t *board_get(void){return &board;}
bool board_mmio_permitted(void){return true;}
bool board_pins_live(void){return true;}
uint32_t SystemCoreClock=168000000u;
bool hal_gpio_configure(hal_pin_t pin,const hal_gpio_cfg_t *cfg){assert(cfg->mode==HAL_GPIO_AF);assert(cfg->af==7||cfg->af==8);pins[gpio_calls++%2]=pin;return true;}
uint32_t hal_millis(void){return now;}
void failsafe_note_rx_frame(uint32_t at){assert(at==now);accepted++;}
static void receive(uint8_t byte,uint32_t errors){port.r->ISR=(1u<<5)|errors;port.r->RDR=byte;receiver_irq();port.r->ISR=0;}
static void frame(uint8_t f[26]){
 memset(f,0,26);f[0]=0xc8;f[1]=24;f[2]=0x16;
 for(unsigned ch=0;ch<16;ch++){unsigned value=ch==2?172:ch==0?1811:992;
  for(unsigned bit=0;bit<11;bit++)if(value&(1u<<bit)){unsigned pos=ch*11+bit;f[3+pos/8]|=1u<<(pos%8);}}
 f[25]=crsf_crc8(f+2,23);
}
int main(void){
 void *region=mmap((void*)0x40000000u,0x30000,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS|MAP_FIXED_NOREPLACE,-1,0);assert(region==(void*)0x40000000u);
 HAL_F7_RCC->CFGR=(5u<<10)|(4u<<13);
 rx_init();assert(rx_uart_bound()&&!rx_frame_fresh());assert(enabled_irq==38&&port.r->BRR==100);assert(pins[0]==HAL_PIN_PACK(0,3)&&pins[1]==HAL_PIN_PACK(0,2));
 uint8_t f[26];frame(f);
 for(unsigned i=0;i<12;i++){receive(f[i],0);}now=1;rx_poll();assert(!rx_frame_fresh());
 for(unsigned i=12;i<26;i++){receive(f[i],0);}now=2;rx_poll();assert(rx_frame_fresh()&&accepted==1&&rx_frame_count()==1);assert(fabsf(rx_channels()[0]-819.f/820.f)<.0001f);assert(rx_channels()[3]==0.f);
 f[25]^=1;for(unsigned i=0;i<26;i++){receive(f[i],0);}now=3;rx_poll();assert(accepted==1&&crsf_crc_errors()==1);f[25]^=1;
 receive(0xc8,8);assert(port.errors==1);now=4;rx_poll();assert(accepted==1);
 for(unsigned i=0;i<700;i++){receive(0x55,0);}assert(port.errors>1);for(unsigned i=0;i<8;i++){now++;rx_poll();}assert(accepted==1);
 for(unsigned i=0;i<26;i++){receive(f[i],0);}now++;rx_poll();assert(accepted==2);
 now+=251;assert(!rx_frame_fresh());
 /* Old buffered bytes after a scheduler stall must not revive the receiver. */
 for(unsigned i=0;i<26;i++){receive(f[i],0);}rx_poll();assert(accepted==2&&!rx_frame_fresh());
 for(unsigned i=0;i<26;i++){receive(f[i],0);}now++;rx_poll();assert(accepted==3&&rx_frame_fresh());
 const unsigned routes[]={1,2,3,4},irqs[]={37,38,39,52};
 const hal_pin_t tx[]={HAL_PIN_PACK(0,9),HAL_PIN_PACK(0,2),HAL_PIN_PACK(2,10),HAL_PIN_PACK(0,0)};
 const hal_pin_t rx[]={HAL_PIN_PACK(0,10),HAL_PIN_PACK(0,3),HAL_PIN_PACK(2,11),HAL_PIN_PACK(0,1)};
 for(unsigned i=0;i<4;i++){hal_uart_cfg_t cfg={routes[i],420000,rx[i],tx[i]};gpio_calls=0;assert(hal_uart_open_cfg(&cfg));assert(enabled_irq==irqs[i]);assert(port.r->BRR==(i?100u:200u));assert(pins[0]==rx[i]&&pins[1]==tx[i]);assert(port.head==0&&port.tail==0);}
 assert(!hal_uart_open_cfg(NULL));hal_uart_cfg_t bad={5,420000,HAL_PIN_PACK(3,2),HAL_PIN_PACK(2,12)};assert(!hal_uart_open_cfg(&bad));
 munmap(region,0x30000);puts("PASS real F7 UART ISR/ring + CRSF: routes/baud, fragmented channels, CRC/error rejection, overflow recovery, freshness and stale-buffer rejection");return 0;
}
