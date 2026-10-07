/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Owned TinyUSB config for BobFlight STM32F405 OTG_FS CDC (device only).
 * Independent F405 config. No ST Cube / Betaflight content.
 */
#ifndef BOBFLIGHT_TUSB_CONFIG_F4_H
#define BOBFLIGHT_TUSB_CONFIG_F4_H

#if !defined(__arm__) || !defined(__thumb__) || !defined(BF_F4_COMPONENT_F405XG)
#error "F405 component configuration requires ARM Thumb and BF_F4_COMPONENT_F405XG"
#endif
#if defined(BF_F4_COMPONENT_F411XE) || defined(STM32F411xx)
#error "F411 is not supported by this USB component"
#endif
#if (defined(CFG_TUD_DWC2_DMA_ENABLE) && CFG_TUD_DWC2_DMA_ENABLE) || (defined(CFG_TUD_MEM_DCACHE_ENABLE) && CFG_TUD_MEM_DCACHE_ENABLE)
#error "USB DMA and cache paths are not supported by this component"
#endif
#ifndef CFG_TUD_DWC2_DMA_ENABLE
#define CFG_TUD_DWC2_DMA_ENABLE 0
#endif
#ifndef CFG_TUD_MEM_DCACHE_ENABLE
#define CFG_TUD_MEM_DCACHE_ENABLE 0
#endif
#if defined(CFG_TUD_DWC2_SLAVE_ENABLE) && !CFG_TUD_DWC2_SLAVE_ENABLE
#error "USB slave mode is required"
#endif
#ifndef CFG_TUD_DWC2_SLAVE_ENABLE
#define CFG_TUD_DWC2_SLAVE_ENABLE 1
#endif

#ifdef __cplusplus
extern "C" {
#endif

#ifndef CFG_TUSB_MCU
#error "CFG_TUSB_MCU must be defined (OPT_MCU_STM32F4)"
#endif

#if CFG_TUSB_MCU != OPT_MCU_STM32F4
#error "CFG_TUSB_MCU must be OPT_MCU_STM32F4"
#endif

#ifndef CFG_TUSB_OS
#define CFG_TUSB_OS           OPT_OS_NONE
#endif

#if CFG_TUSB_OS != OPT_OS_NONE
#error "Unsupported OS: CFG_TUSB_OS must be OPT_OS_NONE"
#endif

#ifndef CFG_TUSB_DEBUG
#define CFG_TUSB_DEBUG        0
#endif

#define CFG_TUD_ENABLED       1

#if defined(CFG_TUH_ENABLED) && (CFG_TUH_ENABLED != 0)
#error "Host mode is disabled"
#else
#define CFG_TUH_ENABLED       0
#endif

#ifndef BOARD_TUD_RHPORT
#define BOARD_TUD_RHPORT      0
#endif

#if BOARD_TUD_RHPORT != 0
#error "BOARD_TUD_RHPORT must be 0 for fullspeed rootport0"
#endif

#ifndef BOARD_TUD_MAX_SPEED
#define BOARD_TUD_MAX_SPEED   OPT_MODE_FULL_SPEED
#endif

#if BOARD_TUD_MAX_SPEED != OPT_MODE_FULL_SPEED
#error "BOARD_TUD_MAX_SPEED must be OPT_MODE_FULL_SPEED"
#endif

#define CFG_TUD_MAX_SPEED     BOARD_TUD_MAX_SPEED

#ifndef CFG_TUSB_MEM_SECTION
#define CFG_TUSB_MEM_SECTION
#endif

#ifndef CFG_TUSB_MEM_ALIGN
#define CFG_TUSB_MEM_ALIGN    __attribute__((aligned(4)))
#endif

#ifndef CFG_TUD_ENDPOINT0_SIZE
#define CFG_TUD_ENDPOINT0_SIZE 64
#endif

/* Classes: CDC only */
#define CFG_TUD_CDC              1
#define CFG_TUD_MSC              0
#define CFG_TUD_HID              0
#define CFG_TUD_MIDI             0
#define CFG_TUD_VENDOR           0

#define CFG_TUD_CDC_RX_BUFSIZE   256
#define CFG_TUD_CDC_TX_BUFSIZE   2048
#define CFG_TUD_CDC_EP_BUFSIZE   64

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_TUSB_CONFIG_F4_H */
