/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
/* Include original peripheral layouts without ARM CMSIS, then supply native
 * stand-ins for core-register reads. Only clock/time entrypoints are executed. */
#include "hal/stm32f7/hal_f7_priv.h"
#define BOBFLIGHT_HAVE_CMSIS 1
typedef struct {uint32_t CTRL,CYCCNT,LAR;} test_dwt_t;
typedef struct {uint32_t DEMCR;} test_debug_t;
extern test_dwt_t test_dwt;extern test_debug_t test_debug;
extern uint32_t test_irq_mask;extern bool test_running;
#define DWT (&test_dwt)
#define CoreDebug (&test_debug)
#define CoreDebug_DEMCR_TRCENA_Msk (1u<<24)
#define DWT_CTRL_CYCCNTENA_Msk 1u
#define DWT_CTRL_NOCYCCNT_Msk (1u<<25)
#define SysTick_IRQn (-1)
static inline uint32_t __get_PRIMASK(void){return test_irq_mask;}
static inline void __disable_irq(void){test_irq_mask=1;}
static inline void __set_PRIMASK(uint32_t v){test_irq_mask=v;}
static inline void __DSB(void){}
static inline void __ISB(void){}
static inline void __NOP(void){if(test_running&&(test_dwt.CTRL&1u))test_dwt.CYCCNT++;}
static inline uint32_t SysTick_Config(uint32_t v){(void)v;return 0;}
static inline void NVIC_SetPriority(int a,unsigned b){(void)a;(void)b;}
