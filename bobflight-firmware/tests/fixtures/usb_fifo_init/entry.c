/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "tusb.h"
#include "portable/synopsys/dwc2/dwc2_common.h"
#ifdef BF_EXPECTED_FIFO_BUDGET
_Static_assert(DWC2_BF_FIFO_SPIN_MAX == BF_EXPECTED_FIFO_BUDGET, "production FIFO budget changed");
#endif
uint32_t fixture_fifo_budget(void) { return DWC2_BF_FIFO_SPIN_MAX; }
bool fixture_flush_tx(void) { return dfifo_flush_tx(DWC2_REG(0),0x10); }
bool fixture_flush_rx(void) { return dfifo_flush_rx(DWC2_REG(0)); }
bool fixture_core_start(void) { return dwc2_core_init(0,false,false); }
static const tusb_rhport_init_t rh={.role=TUSB_ROLE_DEVICE,.speed=TUSB_SPEED_FULL};
bool fixture_dcd_start(void) { return dcd_init(0,&rh); }
bool fixture_tud_start(void) { return tud_rhport_init(0,&rh); }
bool fixture_tusb_start(void) { return tusb_init(0,&rh); }
bool fixture_legacy_start(void) { return tusb_rhport_init(0,NULL); }
