/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * STM32F7 family helpers. Peripheral bases are from ST RM0431 (MCU map),
 * not a board pinout. ARM CMSIS Core is optional. MMIO is gated on a
 * Hardware-verified / bf-derived IR — dummy board never touches registers.
 */
#ifndef BOBFLIGHT_HAL_F7_PRIV_H
#define BOBFLIGHT_HAL_F7_PRIV_H

#include "hal/hal.h"
#include <stdint.h>
#include <stddef.h>

#if defined(BOBFLIGHT_HAVE_CMSIS)
#include "cmsis_cm7_device.h"
#include "core_cm7.h"
#endif

/* AHB1 GPIO / RCC / USB bases (F7) — public MCU map, not board pins. */
#define HAL_F7_GPIOA_BASE      0x40020000u
#define HAL_F7_RCC_BASE        0x40023800u
#define HAL_F7_GPIO_STRIDE     0x400u
#define HAL_F7_USB_OTG_FS_BASE 0x50000000u

/* Owned register layouts (RM0431). Not ST headers. */
typedef struct {
    volatile uint32_t MODER;
    volatile uint32_t OTYPER;
    volatile uint32_t OSPEEDR;
    volatile uint32_t PUPDR;
    volatile uint32_t IDR;
    volatile uint32_t ODR;
    volatile uint32_t BSRR;
    volatile uint32_t LCKR;
    volatile uint32_t AFR[2];
} hal_f7_gpio_regs_t;

/* RCC — enough for HSE/PLL/SYSCLK, GPIO AHB1, OTGFS AHB2 (RM0431 offsets). */
typedef struct {
    volatile uint32_t CR;         /* 0x00 */
    volatile uint32_t PLLCFGR;    /* 0x04 */
    volatile uint32_t CFGR;       /* 0x08 */
    volatile uint32_t CIR;        /* 0x0C */
    volatile uint32_t AHB1RSTR;   /* 0x10 */
    volatile uint32_t AHB2RSTR;   /* 0x14 */
    volatile uint32_t AHB3RSTR;   /* 0x18 */
    uint32_t          RESERVED0;  /* 0x1C */
    volatile uint32_t APB1RSTR;   /* 0x20 */
    volatile uint32_t APB2RSTR;   /* 0x24 */
    uint32_t          RESERVED1[2]; /* 0x28, 0x2C */
    volatile uint32_t AHB1ENR;    /* 0x30 */
    volatile uint32_t AHB2ENR;    /* 0x34 */
    volatile uint32_t AHB3ENR;    /* 0x38 */
    uint32_t          RESERVED2;  /* 0x3C */
    volatile uint32_t APB1ENR;    /* 0x40 */
    volatile uint32_t APB2ENR;    /* 0x44 */
    uint32_t          RESERVED3[2]; /* 0x48, 0x4C */
    volatile uint32_t AHB1LPENR;  /* 0x50 */
    volatile uint32_t AHB2LPENR;  /* 0x54 */
    volatile uint32_t AHB3LPENR;  /* 0x58 */
    uint32_t          RESERVED4;  /* 0x5C */
    volatile uint32_t APB1LPENR;  /* 0x60 */
    volatile uint32_t APB2LPENR;  /* 0x64 */
    uint32_t          RESERVED5[2]; /* 0x68, 0x6C */
    volatile uint32_t BDCR;       /* 0x70 */
    volatile uint32_t CSR;        /* 0x74 */
    uint32_t          RESERVED6[2]; /* 0x78, 0x7C */
    volatile uint32_t SSCGR;      /* 0x80 */
    volatile uint32_t PLLI2SCFGR; /* 0x84 */
    volatile uint32_t PLLSAICFGR; /* 0x88 */
    volatile uint32_t DCKCFGR1;   /* 0x8C */
    volatile uint32_t DCKCFGR2;   /* 0x90 — RM0431: CK48MSEL @ bit27 */
} hal_f7_rcc_regs_t;

#define HAL_F7_RCC ((hal_f7_rcc_regs_t *)(uintptr_t)HAL_F7_RCC_BASE)

/* RCC_CR bits */
#define HAL_F7_RCC_CR_HSION    (1u << 0)
#define HAL_F7_RCC_CR_HSIRDY   (1u << 1)
#define HAL_F7_RCC_CR_HSEON    (1u << 16)
#define HAL_F7_RCC_CR_HSERDY   (1u << 17)
#define HAL_F7_RCC_CR_HSEBYP   (1u << 18) /* external clock on OSC_IN (TCXO / clock-in) */
#define HAL_F7_RCC_CR_PLLON    (1u << 24)
#define HAL_F7_RCC_CR_PLLRDY   (1u << 25)

/* RCC_PLLCFGR helpers: PLLM/N/P/Q + HSE source */
#define HAL_F7_RCC_PLLCFGR_PLLSRC_HSE (1u << 22)

/* RCC_CFGR SW/SWS */
#define HAL_F7_RCC_CFGR_SW_PLL  (2u << 0)
#define HAL_F7_RCC_CFGR_SWS_PLL (2u << 2)
#define HAL_F7_RCC_CFGR_SWS_Msk (3u << 2)

/* AHB2ENR OTGFSEN */
#define HAL_F7_RCC_AHB2ENR_OTGFSEN (1u << 7)

/* FLASH ACR (for wait states at high SYSCLK) */
#define HAL_F7_FLASH_BASE 0x40023C00u
typedef struct {
    volatile uint32_t ACR;
} hal_f7_flash_regs_t;
#define HAL_F7_FLASH ((hal_f7_flash_regs_t *)(uintptr_t)HAL_F7_FLASH_BASE)
#define HAL_F7_FLASH_ACR_LATENCY_Msk 0x0Fu
#define HAL_F7_FLASH_ACR_PRFTEN      (1u << 8)
#define HAL_F7_FLASH_ACR_ARTEN       (1u << 9)

bool hal_f7_pin_decode(hal_pin_t pin, unsigned *port, unsigned *num);
bool hal_f7_mmio_ok(hal_pin_t pin, unsigned *port, unsigned *num);
void hal_f7_rcc_gpio_enable(unsigned port);
hal_f7_gpio_regs_t *hal_f7_gpio(unsigned port);


/* DCKCFGR2 CK48MSEL: 0=PLLQ, 1=PLLSAIP (RM0431) */
#define HAL_F7_RCC_DCKCFGR2_CK48MSEL (1u << 27)

/* PWR (APB1) — Scale1 + over-drive for 216 MHz (RM0431) */
#define HAL_F7_PWR_BASE 0x40007000u
typedef struct {
    volatile uint32_t CR1;
    volatile uint32_t CSR1;
} hal_f7_pwr_regs_t;
#define HAL_F7_PWR ((hal_f7_pwr_regs_t *)(uintptr_t)HAL_F7_PWR_BASE)
#define HAL_F7_RCC_APB1ENR_PWREN (1u << 28)
#define HAL_F7_PWR_CR1_VOS_SCALE1 (0x3u << 14) /* VOS[1:0]=11 Scale 1 */
#define HAL_F7_PWR_CR1_VOS_Msk    (0x3u << 14)
#define HAL_F7_PWR_CR1_ODEN       (1u << 16)
#define HAL_F7_PWR_CR1_ODSWEN     (1u << 17)
#define HAL_F7_PWR_CSR1_VOSRDY    (1u << 14) /* VOS ready after Scale change (RM0431) */
#define HAL_F7_PWR_CSR1_ODRDY     (1u << 16)
#define HAL_F7_PWR_CSR1_ODSWRDY   (1u << 17)

/** Enable USB OTG FS AHB2 clock (MMIO gated). */
void hal_f7_rcc_otgfs_enable(void);


/* Compile-time layout guards — wrong offsetof → HardFault on first DCKCFGR2/PWR touch. */
_Static_assert(offsetof(hal_f7_rcc_regs_t, DCKCFGR2) == 0x90u, "hal_f7_rcc_regs_t.DCKCFGR2 must be @0x90");
_Static_assert(HAL_F7_PWR_BASE == 0x40007000u, "PWR base must be 0x40007000 (RM0431)");
_Static_assert(HAL_F7_PWR_CSR1_VOSRDY == (1u << 14), "PWR_CSR1.VOSRDY must be bit14");
_Static_assert(HAL_F7_PWR_CR1_VOS_SCALE1 == (0x3u << 14), "PWR_CR1.VOS Scale1 must be bits[15:14]=11");

extern uint32_t SystemCoreClock;
static inline uint32_t hal_f7_pclk(bool apb2) {
    unsigned n = (HAL_F7_RCC->CFGR >> (apb2 ? 13 : 10)) & 7u;
    return SystemCoreClock >> (n < 4 ? 0 : n - 3);
}
static inline uint32_t hal_f7_timclk(bool apb2) {
    uint32_t p = hal_f7_pclk(apb2);
    return p == SystemCoreClock ? p : p * 2u;
}
#endif /* BOBFLIGHT_HAL_F7_PRIV_H */
