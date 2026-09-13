/* SPDX-License-Identifier: Apache-2.0
 * STM32F745 1 MiB, RM0385 flash chapter: sectors 6/7, x8 programming.
 * Blocking bench-only operations. Same-bank instruction fetches may stall;
 * no assertion of real-time service or a wall-clock timeout while BSY is set.
 * Caller MUST be disarmed, motor-bench stopped, calibration inactive.
 */
#include "hal/hal.h"
#include "board/board.h"
#include <string.h>
#if defined(BOBFLIGHT_CONFIG_FLASH_F745) && defined(BOBFLIGHT_HAVE_CMSIS)
#include "hal_f7_priv.h"
#include "flash_watchdog.h"
#include "flight/arming.h"
#include "drivers/gyro.h"
#include "sched/tasks.h"
#define REG32(a) (*(volatile uint32_t *)(uintptr_t)(a))
#define FLASH_KEYR REG32(0x40023C04u)
#define FLASH_SR REG32(0x40023C0Cu)
#define FLASH_CR REG32(0x40023C10u)
#define CFG_BASE 0x08080000u
#define SLOT_BYTES 0x40000u
#define BUSY (1u<<16)
#define LOCK (1u<<31)
#define ERRORS 0xF2u
static bool bounds(uint32_t off,size_t n){return off<=2u*SLOT_BYTES&&n<=2u*SLOT_BYTES-off;}
bool hal_flash_supported(void){
 const board_t*b=board_get();
 return b&&board_mmio_permitted()&&!strcmp(b->board_id,"kakute_f7_hdv")&&
  (REG32(0xE0042000u)&0xFFFu)==0x449u&&
  *(volatile const uint16_t *)(uintptr_t)0x1FF0F442u==1024u;
}
const char *hal_flash_backend(void){return hal_flash_supported()?"flash":"unsupported";}
/* Poll count bounds repeated register reads; same-bank fetch stalls are not timed. */
static bool idle(void){for(uint32_t i=0;i<100000000u;i++)if(!(FLASH_SR&BUSY))return true;return false;}
static bool unlock(void){if(!idle())return false;if(FLASH_CR&LOCK){FLASH_KEYR=0x45670123u;FLASH_KEYR=0xCDEF89ABu;}return !(FLASH_CR&LOCK);}
typedef struct {uint32_t irq;bool dcache;} flash_context_t;
static flash_context_t enter(void){flash_context_t c={__get_PRIMASK(),(SCB->CCR&SCB_CCR_DC_Msk)!=0};__disable_irq();__DSB();if(c.dcache)SCB_DisableDCache();__DSB();__ISB();return c;}
static void leave(flash_context_t c){
 /* No configuration bytes are executable. Invalidating I-cache cannot change code. */
 __DSB();SCB_InvalidateICache();if(c.dcache)SCB_EnableDCache();__DSB();__ISB();__set_PRIMASK(c.irq);
}
bool hal_flash_read(uint32_t off,void *dst,size_t n){if(!dst||!bounds(off,n)||!hal_flash_supported()||(FLASH_SR&BUSY))return false;memcpy(dst,(const void *)(uintptr_t)(CFG_BASE+off),n);return true;}
bool hal_flash_erase_slot(unsigned slot){
 if(slot>=2||!hal_flash_supported())return false;
#if defined(BOBFLIGHT_FLIGHT_ENABLE) && BOBFLIGHT_FLIGHT_ENABLE
 return false;
#endif
 if(arming_state()==ARM_ARMED||bench_motor_active()||gyro_manual_calibration_active())return false;
 flash_iwdg_t *wd=(flash_iwdg_t *)(uintptr_t)0x40003000u;
 flash_iwdg_saved_t saved;
 /* Code fetches stall during same-bank erase. Set a bounded maintenance
  * window BEFORE starting it, and restore normal watchdog timing on all
  * returning paths. A failed watchdog handshake must reset, never resume
  * the controller with an unverified longer timeout. */
 if(!flash_iwdg_begin(wd,&saved))for(;;){}
 flash_context_t c=enter();bool ok=unlock();
 if(ok){FLASH_SR=ERRORS|1u;FLASH_CR=(1u<<1)|((6u+slot)<<3);FLASH_CR|=1u<<16;__DSB();ok=idle()&&!(FLASH_SR&ERRORS);}
 if(!(FLASH_SR&BUSY)){FLASH_CR=LOCK;FLASH_SR=ERRORS|1u;}
 if(!flash_iwdg_end(wd,&saved))for(;;){}
 leave(c);return ok;
}
bool hal_flash_write(uint32_t off,const void *src,size_t n){
 if(!src||!bounds(off,n)||!hal_flash_supported())return false;
 /* Reject aliasing the flash source: this routine expects a RAM record. */
 uintptr_t source=(uintptr_t)src;if(source<0x20000000u||source>=0x40000000u||n>0x40000000u-source)return false;
 const uint8_t *p=src;flash_context_t c=enter();bool ok=unlock();
 for(size_t i=0;ok&&i<n;i++){
  volatile uint8_t *dst=(volatile uint8_t *)(uintptr_t)(CFG_BASE+off+i);
  if((*dst&p[i])!=p[i]){ok=false;break;}
  if(*dst==p[i])continue;
  FLASH_SR=ERRORS|1u;FLASH_CR=1u; /* PG=1, PSIZE=00 (x8), no erase bits. */
  *dst=p[i];__DSB();ok=idle()&&!(FLASH_SR&ERRORS)&&*dst==p[i];
 }
 if(!(FLASH_SR&BUSY)){FLASH_CR=LOCK;FLASH_SR=ERRORS|1u;}
 leave(c);return ok;
}
#else
bool hal_flash_supported(void){return false;}
const char *hal_flash_backend(void){return "unsupported";}
bool hal_flash_erase_slot(unsigned slot){(void)slot;return false;}
bool hal_flash_read(uint32_t off,void *dst,size_t n){(void)off;if(dst&&n)memset(dst,255,n);return false;}
bool hal_flash_write(uint32_t off,const void *src,size_t n){(void)off;(void)src;(void)n;return false;}
#endif
