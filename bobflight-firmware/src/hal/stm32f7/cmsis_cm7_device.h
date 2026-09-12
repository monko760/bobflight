/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owned Cortex-M7 device macros so ARM CMSIS Core can compile without
 * ST Cube / CMSIS-Device. Values are Cortex-M7 architecture + F7 family
 * facts (ARM TRM / RM0431), not board pins.
 */
#ifndef BOBFLIGHT_CMSIS_CM7_DEVICE_H
#define BOBFLIGHT_CMSIS_CM7_DEVICE_H

#include <stdint.h>

#define __CM7_REV              0x0100U
#define __MPU_PRESENT          1U
#define __NVIC_PRIO_BITS       4U
#define __Vendor_SysTickConfig 0U
#define __FPU_PRESENT          1U
#define __ICACHE_PRESENT       1U
#define __DCACHE_PRESENT       1U
#define __DTCM_PRESENT         1U

/*
 * System exceptions + selected peripheral IRQs needed by TinyUSB DWC2 OTG_FS.
 * IRQ numbers from public STM32F74x vector map (RM0431) — not Betaflight.
 */
typedef enum {
    NonMaskableInt_IRQn   = -14,
    HardFault_IRQn        = -13,
    MemoryManagement_IRQn = -12,
    BusFault_IRQn         = -11,
    UsageFault_IRQn       = -10,
    SVCall_IRQn           = -5,
    DebugMonitor_IRQn     = -4,
    PendSV_IRQn           = -2,
    SysTick_IRQn          = -1,
    /* External interrupts (partial owned table) */
    WWDG_IRQn             = 0,
    OTG_FS_IRQn           = 67  /* USB OTG FS global interrupt */
} IRQn_Type;

#endif /* BOBFLIGHT_CMSIS_CM7_DEVICE_H */
