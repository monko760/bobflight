/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_FLASH_WATCHDOG_H
#define BOBFLIGHT_FLASH_WATCHDOG_H
#include <stdint.h>
#include <stdbool.h>
typedef struct {volatile uint32_t KR,PR,RLR,SR,WINR;} flash_iwdg_t;
typedef struct {uint32_t prescaler,reload;} flash_iwdg_saved_t;
static bool flash_iwdg_wait(flash_iwdg_t *r){
 /* Never feed during a failed register update: the running watchdog recovers. */
 for(unsigned n=0;n<1000000u;n++)if(!(r->SR&7u))return true;
 return false;
}
static bool flash_iwdg_configure(flash_iwdg_t *r,uint32_t prescaler,uint32_t reload){
 r->KR=0xAAAAu;
 r->KR=0x5555u;r->PR=prescaler;r->RLR=reload;
 if(!flash_iwdg_wait(r))return false;
 r->KR=0xAAAAu;
 return r->PR==prescaler&&r->RLR==reload;
}
static bool flash_iwdg_begin(flash_iwdg_t *r,flash_iwdg_saved_t *saved){
 if(!flash_iwdg_wait(r))return false;
 saved->prescaler=r->PR;saved->reload=r->RLR;
 /* /256 * 1024: 8.192 s at nominal 32 kHz, >5.5 s at max 47 kHz.
  * DS10916 Tables 43/49: x8 256 KiB erase maximum 4 s. No disable, no
  * periodic reload in the erase loop: a stuck erase still resets. */
 return flash_iwdg_configure(r,6u,1023u);
}
static bool flash_iwdg_end(flash_iwdg_t *r,const flash_iwdg_saved_t *saved){
 return flash_iwdg_configure(r,saved->prescaler,saved->reload);
}
#endif
