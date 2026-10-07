/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/* Link diagnostic only. Reset stops before board-specific USB initialization. */
#include "tusb.h"
#include "stm32f4xx.h"
#include "hal/stm32f4/usb_time.h"
extern volatile uint32_t fixture_time_ready;
extern bf_f4_clock_plan_t fixture_clocks;
void OTG_FS_IRQHandler(void) { tusb_int_handler(0,true); }
bool fixture_usb_time_bind(void) { return bf_f405_usb_time_bind(&fixture_clocks); }
bool fixture_usb_time_bind_null(void) { return bf_f405_usb_time_bind(0); }
/* Caller assertion is not hardware verification. No reset path calls this. */
bool fixture_usb_stack_init(bool board_prepared, bool vbus_sensing)
{
    if(!board_prepared || !fixture_time_ready || fixture_clocks.usb_hz!=48000000u)return false;
    if(!bf_f405_usb_time_bind(&fixture_clocks))return false;
    const tusb_rhport_init_t rh={.role=TUSB_ROLE_DEVICE,.speed=TUSB_SPEED_FULL};
    const tud_configure_param_t cfg={.dwc2={.bm_double_buffered=0,.vbus_sensing=vbus_sensing}};
    return tud_configure(0,TUD_CFGID_DWC2,&cfg) && tusb_init(0,&rh);
}
void fixture_irq_enable(uint32_t irq) { NVIC_EnableIRQ((IRQn_Type)irq); }
void fixture_irq_disable(uint32_t irq) { NVIC_DisableIRQ((IRQn_Type)irq); }
