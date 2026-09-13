/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Owned software-reset -> early ST system-memory handoff. No flash/option-byte
 * writes and NO watchdog changes. ST AN2606 Rev61: tables81/83/85/177;
 * Cortex-M7 ARMv7-M AIRCR, VTOR, stack and exception-mask semantics.
 */
#include "hal/hal.h"
#include "board/board.h"
#include "bootloader_policy.h"
#include <string.h>
#define REG32(a) (*(volatile uint32_t *)(uintptr_t)(a))
#define REG16(a) (*(volatile uint16_t *)(uintptr_t)(a))
#define RCC_CSR REG32(0x40023874u)
#define AIRCR REG32(0xE000ED0Cu)

/* DTCM .noinit, outside .data/.bss; consume before ANY normal initialization. */
static volatile bl_cookie_t boot_cookie __attribute__((section(".noinit"),aligned(8)));
static bool rom_device_eligible(void){
 uint32_t device=REG32(0xE0042000u)&0xFFFu;
#if defined(BOBFLIGHT_TARGET_TMOTORF7V2)
 return device==0x452u&&REG16(0x1FF07A22u)==512u;
#elif defined(BOBFLIGHT_CONFIG_FLASH_F745)
 return device==0x449u&&REG16(0x1FF0F442u)==1024u;
#else
 (void)device;return false;
#endif
}
static bool rom_vectors_ok(void){
#if defined(BOBFLIGHT_TARGET_TMOTORF7V2)
 const uint32_t ram_end=0x20040000u;
#else
 const uint32_t ram_end=0x20050000u;
#endif
 return bl_vectors_valid(REG32(BL_ROM_BASE),REG32(BL_ROM_BASE+4u),ram_end);
}
bool hal_bootloader_supported(void){
 const board_t *b=board_get();
 if(!b||!board_mmio_permitted())return false;
#if defined(BOBFLIGHT_TARGET_TMOTORF7V2)
 if(strcmp(b->board_id,"tmotor_f7_v2"))return false;
#elif defined(BOBFLIGHT_CONFIG_FLASH_F745)
 if(strcmp(b->board_id,"kakute_f7_hdv"))return false;
#else
 return false;
#endif
 return rom_device_eligible()&&rom_vectors_ok();
}
extern void hal_usb_cdc_bootloader_disconnect(void);
bool hal_bootloader_request(void){
 if(!hal_bootloader_supported())return false;
 __asm volatile("cpsid i" ::: "memory");
 hal_usb_cdc_bootloader_disconnect();
 /* Reset flags are sticky; clear them BEFORE setting the one-shot request. */
 RCC_CSR|=1u<<24;
 boot_cookie.inverse=~BL_MAGIC;boot_cookie.magic=BL_MAGIC;
 __asm volatile("dsb" ::: "memory");
 AIRCR=0x05FA0004u|(AIRCR&0x700u);
 __asm volatile("dsb" ::: "memory");
 for(;;){__asm volatile("nop");} /* reset should win; IWDG remains unchanged */
}
/* No C instructions, calls or stack accesses after replacing MSP. */
__attribute__((naked,noreturn)) static void rom_enter(uint32_t sp __attribute__((unused)),uint32_t pc __attribute__((unused))){
 __asm volatile(
  "movs r2, #0\n"
  "msr control, r2\n"
  "msr basepri, r2\n"
  "msr faultmask, r2\n"
  "msr msp, r0\n"
  "dsb\n"
  "isb\n"
  "cpsie i\n"
  "bx r1\n");
}
void hal_bootloader_early_check(void){
 uint32_t cause=RCC_CSR;
 bool requested=bl_cookie_consume(&boot_cookie,cause);
 RCC_CSR|=1u<<24;
 if(!requested||!rom_device_eligible()||!rom_vectors_ok())return;
 __asm volatile("cpsid i" ::: "memory");
 /* Only the requested reset path: bounded USB-detach settling at reset HSI.
  * No running flight loop exists here. This is not a calibrated time source. */
 for(volatile uint32_t settle=200000u;settle;--settle){__asm volatile("nop");}
 REG32(0xE000E010u)=0;REG32(0xE000E014u)=0;REG32(0xE000E018u)=0;
 for(unsigned i=0;i<8;i++){
  REG32(0xE000E180u+4u*i)=0xFFFFFFFFu;
  REG32(0xE000E280u+4u*i)=0xFFFFFFFFu;
 }
 REG32(0xE000ED04u)=(1u<<27)|(1u<<25); /* clear PendSV/SysTick */
 /* Fresh SYSTEM reset supplied default clocks/cache/FPU state. Do not jump
  * directly here from a live application; only Reset_Handler calls this. */
 REG32(0x40023844u)|=1u<<14; /* SYSCFGEN */
 (void)REG32(0x40023844u);
 REG32(0x40013800u)=(REG32(0x40013800u)&~7u)|1u; /* ROM alias at zero */
 REG32(0xE000ED08u)=BL_ROM_BASE;
 uint32_t sp=REG32(BL_ROM_BASE),pc=REG32(BL_ROM_BASE+4u);
 __asm volatile("dsb\n isb" ::: "memory");
 rom_enter(sp,pc);
}
