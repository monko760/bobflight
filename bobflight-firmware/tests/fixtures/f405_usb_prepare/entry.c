/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "hal/stm32f4/usb_prepare.h"
extern bf_f4_clock_plan_t fixture_clocks;
uint32_t fixture_prepare(uint32_t vbus)
{ return (uint32_t)bf_f405_usb_prepare(&fixture_clocks,(bf_f405_usb_vbus_t)vbus); }
uint32_t fixture_prepare_null(uint32_t vbus)
{ return (uint32_t)bf_f405_usb_prepare(0,(bf_f405_usb_vbus_t)vbus); }
