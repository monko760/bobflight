/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#include <stdio.h>
#include <string.h>
/* clock_hw_mock.h is force-included by this test target. */
test_dwt_t test_dwt;test_debug_t test_debug;
uint32_t test_irq_mask;bool test_running=true,allowed=true;
extern uint32_t SystemCoreClock;void SysTick_Handler(void);
bool board_mmio_permitted(void){return allowed;}
#define CHECK(x) do{if(!(x)){fprintf(stderr,"F7 clock FAIL line %d: %s\n",__LINE__,#x);return 1;}}while(0)
int main(void){
 CHECK(!hal_time_high_resolution()&&hal_micros()==0);
 SysTick_Handler();CHECK(hal_micros()==1000);
 uint32_t frequencies[]={16000000,168000000,216000000};
 for(unsigned f=0;f<3;f++){
  SystemCoreClock=frequencies[f];test_dwt.CYCCNT=0xfffffff0u;test_irq_mask=f&1u;
  hal_time_init();CHECK(test_irq_mask==(f&1u));CHECK(hal_micros()==0);
  CHECK(hal_time_high_resolution()&&!strcmp(hal_time_source(),"dwt-cyccnt"));
  CHECK(hal_core_clock_hz()==frequencies[f]);
  for(unsigned i=0;i<25000;i++){test_dwt.CYCCNT+=frequencies[f]/1000;SysTick_Handler();}
  CHECK(hal_micros()==25000000ull&&hal_millis()==25000);
  test_dwt.CYCCNT+=frequencies[f]/1000000*125u;
  CHECK(hal_micros()==25000125ull&&test_irq_mask==(f&1u));
  test_dwt.CTRL&=~1u;CHECK(!hal_time_high_resolution());CHECK(hal_micros()==25000125ull);
  SysTick_Handler();CHECK(hal_micros()==25001000ull);
 }
 test_dwt.CTRL=0;test_running=false;hal_time_init();CHECK(!hal_time_high_resolution());
 CHECK(!strcmp(hal_time_source(),"systick-ms-fallback"));SysTick_Handler();CHECK(hal_micros()==1000);
 test_running=true;test_dwt.CTRL=DWT_CTRL_NOCYCCNT_Msk;hal_time_init();CHECK(!hal_time_high_resolution());
 test_dwt.CTRL=0;allowed=false;hal_time_init();CHECK(!hal_time_high_resolution());
 allowed=true;SystemCoreClock=16500000;hal_time_init();CHECK(!hal_time_high_resolution());
 SystemCoreClock=168000000;hal_time_init();CHECK(hal_time_high_resolution());
 SystemCoreClock=216000000;CHECK(!hal_time_high_resolution());
 puts("PASS actual F7 time code with simulated core registers: startup, wraps, interrupt-mask preservation, disabled/stuck/unavailable counter, unsupported/runtime frequency, monotonic fallback");return 0;
}
