/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "hal/stm32f4/gyro_gpio_prepare.h"
volatile unsigned fixture_case,fixture_result,fixture_again;
__attribute__((noreturn,noinline)) void fixture_done(void) { for(;;)__asm volatile("nop"); }
void bf_f4_component_entry(void)
{
 board_t b={0};
 b.gyro_spi_bus=1;b.gyro_cs_pin=HAL_PIN_PACK(0,4);
 b.gyro_sck_pin=HAL_PIN_PACK(0,5);b.gyro_miso_pin=HAL_PIN_PACK(0,6);b.gyro_mosi_pin=HAL_PIN_PACK(0,7);
 b.gyro_exti_pin=HAL_PIN_PACK(2,5);
 switch(fixture_case) {
 case 1:b.gyro_spi_bus=2;break;
 case 2:b.gyro_cs_pin=HAL_PIN_PACK(0,3);break;
 case 3:b.gyro_sck_pin=HAL_PIN_PACK(1,3);break;
 case 4:b.gyro_miso_pin=HAL_PIN_PACK(1,4);break;
 case 5:b.gyro_mosi_pin=HAL_PIN_PACK(1,5);break;
 case 6:b.gyro_exti_pin=HAL_PIN_PACK(2,4);break;
 }
 bf_f405_gyro_cs_cb(NULL,true);
 fixture_result=bf_f405_gyro_gpio_prepare(fixture_case==7?NULL:&b);
 fixture_again=bf_f405_gyro_gpio_prepare(fixture_case==7?NULL:&b);
 __asm volatile("cpsie i" ::: "memory");
 bf_f405_gyro_cs_cb(NULL,true);
 bf_f405_gyro_cs_cb(NULL,false);
 fixture_done();
}
