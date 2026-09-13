/* SPDX-License-Identifier: Apache-2.0 */
#include <assert.h>
#include "hal/stm32f7/flash_watchdog.h"
int main(void){
 flash_iwdg_t r={0,3,249,0,4095};flash_iwdg_saved_t saved;
 assert(flash_iwdg_begin(&r,&saved));
 assert(saved.prescaler==3&&saved.reload==249);
 assert(r.PR==6&&r.RLR==1023&&r.KR==0xAAAA&&r.WINR==4095);
 assert(256u*1024u>47000u*4u); /* worst-case LSI still covers erase maximum */
 assert(flash_iwdg_end(&r,&saved));assert(r.PR==3&&r.RLR==249);
 r.PR=4;r.RLR=511;assert(flash_iwdg_begin(&r,&saved));
 assert(flash_iwdg_end(&r,&saved));assert(r.PR==4&&r.RLR==511);
 r.SR=1;r.KR=0;assert(!flash_iwdg_begin(&r,&saved));assert(r.KR==0);
 assert(!flash_iwdg_end(&r,&saved));assert(r.KR==0x5555);
 return 0;
}
