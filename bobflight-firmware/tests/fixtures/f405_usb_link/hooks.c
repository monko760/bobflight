/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/* Link diagnostic only. The reset fixture stops before board-specific USB setup. */
#include "tusb.h"
#include "stm32f4xx.h"
#include "hal/stm32f4/timebase.h"
#include "hal/stm32f4/clock_plan.h"
extern volatile uint32_t fixture_time_ready;
extern bf_f4_clock_plan_t fixture_clocks;
uint32_t SystemCoreClock;
volatile uint32_t fixture_usb_fault_code;
__attribute__((noinline,noreturn)) void fixture_usb_fault(void)
{
    __asm volatile("cpsid i" ::: "memory");
    fixture_usb_fault_code=1;
    for(;;){__asm volatile("nop");}
}
uint32_t tusb_time_millis_api(void)
{
    uint32_t ms;
    if(!bf_f405_time_read_ms(&ms))fixture_usb_fault();
    return ms;
}
void tusb_time_delay_ms_api(uint32_t ms)
{
    /* Diagnostic ceiling, not a measured wall-clock timeout. */
    if(ms>100u)fixture_usb_fault();
    uint32_t start=tusb_time_millis_api();
    for(uint32_t budget=1000000u;budget;--budget){
        if((uint32_t)(tusb_time_millis_api()-start)>=ms)return;
    }
    fixture_usb_fault();
}
void OTG_FS_IRQHandler(void) { tusb_int_handler(0,true); }
/* Never called by the reset fixture. true is a caller assertion, not board
 * verification: RCC/GPIO/PHY/VBUS setup is a separate unfinished prerequisite. */
bool fixture_usb_stack_init(bool board_prepared, bool vbus_sensing)
{
    if(!board_prepared || !fixture_time_ready || fixture_clocks.usb_hz!=48000000u)return false;
    uint32_t now;
    if(!bf_f405_time_read_ms(&now))return false;
    SystemCoreClock=fixture_clocks.hclk_hz;
    const tusb_rhport_init_t rh={.role=TUSB_ROLE_DEVICE,.speed=TUSB_SPEED_FULL};
    const tud_configure_param_t cfg={.dwc2={.bm_double_buffered=0,.vbus_sensing=vbus_sensing}};
    return tud_configure(0,TUD_CFGID_DWC2,&cfg) && tusb_init(0,&rh);
}

void fixture_irq_enable(uint32_t irq) { NVIC_EnableIRQ((IRQn_Type)irq); }
void fixture_irq_disable(uint32_t irq) { NVIC_DisableIRQ((IRQn_Type)irq); }
