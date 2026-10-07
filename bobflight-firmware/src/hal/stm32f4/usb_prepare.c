/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "usb_prepare.h"
#include "timebase.h"
#include <stddef.h>

#if !defined(__arm__) || !defined(__thumb__)
#error "usb_prepare requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for usb_prepare"
#endif

#if defined(BF_F4_COMPONENT_F411XE)
#error "BF_F4_COMPONENT_F411XE must NOT be defined for usb_prepare"
#endif

#define RCC_CR        (*(volatile uint32_t *)0x40023800u)
#define RCC_PLLCFGR   (*(volatile uint32_t *)0x40023804u)
#define RCC_CFGR      (*(volatile uint32_t *)0x40023808u)
#define RCC_AHB1ENR   (*(volatile uint32_t *)0x40023830u)
#define RCC_AHB2RSTR  (*(volatile uint32_t *)0x40023814u)
#define RCC_AHB2ENR   (*(volatile uint32_t *)0x40023834u)

#define GPIOA_MODER   (*(volatile uint32_t *)0x40020000u)
#define GPIOA_OTYPER  (*(volatile uint32_t *)0x40020004u)
#define GPIOA_OSPEEDR (*(volatile uint32_t *)0x40020008u)
#define GPIOA_PUPDR   (*(volatile uint32_t *)0x4002000Cu)
#define GPIOA_AFRH    (*(volatile uint32_t *)0x40020024u)

#define NVIC_ISER2    (*(volatile uint32_t *)0xE000E108u)
#define NVIC_ICER2    (*(volatile uint32_t *)0xE000E188u)
#define NVIC_ICPR2    (*(volatile uint32_t *)0xE000E288u)
#define NVIC_IPR67    (*(volatile uint8_t  *)0xE000E443u)

static bool s_attempted = false;

bf_f405_usb_prepare_status_t bf_f405_usb_prepare(
    const bf_f4_clock_plan_t *clocks,
    bf_f405_usb_vbus_t vbus)
{
    uint32_t ipsr = 0u;
    __asm__ __volatile__("mrs %0, ipsr" : "=r"(ipsr));
    if (ipsr != 0u) {
        return BF_F405_USB_PREPARE_CONTEXT;
    }

    uint32_t primask = 0u;
    __asm__ __volatile__("mrs %0, primask" : "=r"(primask));
    if ((primask & 1u) == 0u) {
        return BF_F405_USB_PREPARE_CONTEXT;
    }

    if (s_attempted) {
        return BF_F405_USB_PREPARE_ALREADY;
    }

    if (!clocks) {
        return BF_F405_USB_PREPARE_INVALID;
    }
    if (vbus != BF_F405_USB_VBUS_BUS_POWERED && vbus != BF_F405_USB_VBUS_PA9) {
        return BF_F405_USB_PREPARE_INVALID;
    }

    if (clocks->hse_hz < 4000000u || clocks->hse_hz > 26000000u ||
        (clocks->hse_hz % 1000000u != 0u)) {
        return BF_F405_USB_PREPARE_INVALID;
    }
    if (clocks->sysclk_hz != 168000000u || clocks->hclk_hz != 168000000u ||
        clocks->usb_hz != 48000000u) {
        return BF_F405_USB_PREPARE_INVALID;
    }
    uint8_t expected_m = (uint8_t)(clocks->hse_hz / 1000000u);
    if (clocks->pll_m != expected_m || clocks->pll_n != 336u ||
        clocks->pll_p != 2u || clocks->pll_q != 7u) {
        return BF_F405_USB_PREPARE_INVALID;
    }
    if (clocks->ahb_div != 1u || clocks->apb1_div != 4u || clocks->apb2_div != 2u) {
        return BF_F405_USB_PREPARE_INVALID;
    }
    if (clocks->apb1_hz != 42000000u || clocks->apb2_hz != 84000000u) {
        return BF_F405_USB_PREPARE_INVALID;
    }

    uint64_t now_us = 0u;
    if (!bf_f405_time_read_us(&now_us)) {
        return BF_F405_USB_PREPARE_TIME;
    }

    uint32_t cr = RCC_CR;
    if ((cr & 0x03070000u) != 0x03030000u) {
        return BF_F405_USB_PREPARE_CLOCK;
    }

    uint32_t expected_pllcfgr = (uint32_t)clocks->pll_m | (336u << 6) | (1u << 22) | (7u << 24);
    uint32_t pllcfgr = RCC_PLLCFGR;
    if ((pllcfgr & 0x0F437FFFu) != expected_pllcfgr) {
        return BF_F405_USB_PREPARE_CLOCK;
    }

    uint32_t cfgr = RCC_CFGR;
    if ((cfgr & 0xFCFFu) != 0x940Au) {
        return BF_F405_USB_PREPARE_CLOCK;
    }

    if ((RCC_AHB2ENR & (1u << 7)) != 0u) {
        return BF_F405_USB_PREPARE_BUSY;
    }
    if ((RCC_AHB2RSTR & (1u << 7)) != 0u) {
        return BF_F405_USB_PREPARE_BUSY;
    }
    if ((NVIC_ISER2 & (1u << 3)) != 0u) {
        return BF_F405_USB_PREPARE_BUSY;
    }

    s_attempted = true;

    /* 1. AHB1ENR: Enable GPIOA clock */
    uint32_t ahb1enr = RCC_AHB1ENR;
    ahb1enr |= (1u << 0);
    RCC_AHB1ENR = ahb1enr;
    __asm__ __volatile__("dsb" ::: "memory");
    if ((RCC_AHB1ENR & (1u << 0)) == 0u) {
        return BF_F405_USB_PREPARE_WRITE;
    }

    /* 2. Configure GPIOA pins PA11, PA12 (and PA9 if PA9 mode)
     * Sequence requirement: AFRH, then OTYPE / SPEED / PUPDR, before MODER last. */
    uint32_t pin_mask_2bit = (3u << 22) | (3u << 24); /* PA11 and PA12 */

    /* AFRH */
    uint32_t afrh = GPIOA_AFRH;
    afrh &= ~0x000FF000u; /* PA11: bits 12..15, PA12: bits 16..19 */
    afrh |= (10u << 12) | (10u << 16);
    GPIOA_AFRH = afrh;
    if (GPIOA_AFRH != afrh) {
        return BF_F405_USB_PREPARE_WRITE;
    }

    /* OTYPER */
    uint32_t otyper = GPIOA_OTYPER;
    otyper &= ~((1u << 11) | (1u << 12)); /* Push-pull for PA11 and PA12 */
    GPIOA_OTYPER = otyper;
    if (GPIOA_OTYPER != otyper) {
        return BF_F405_USB_PREPARE_WRITE;
    }

    /* OSPEEDR */
    uint32_t ospeedr = GPIOA_OSPEEDR;
    ospeedr |= pin_mask_2bit; /* Very high speed = 3 for PA11 and PA12 */
    GPIOA_OSPEEDR = ospeedr;
    if (GPIOA_OSPEEDR != ospeedr) {
        return BF_F405_USB_PREPARE_WRITE;
    }

    /* PUPDR */
    uint32_t pupdr = GPIOA_PUPDR;
    pupdr &= ~pin_mask_2bit; /* No pull for PA11 and PA12 */
    if (vbus == BF_F405_USB_VBUS_PA9) {
        pupdr &= ~(3u << 18); /* No pull for PA9 */
    }
    GPIOA_PUPDR = pupdr;
    if (GPIOA_PUPDR != pupdr) {
        return BF_F405_USB_PREPARE_WRITE;
    }

    /* MODER (last) */
    uint32_t moder = GPIOA_MODER;
    moder = (moder & ~pin_mask_2bit) | (2u << 22) | (2u << 24); /* AF mode = 2 for PA11 and PA12 */
    if (vbus == BF_F405_USB_VBUS_PA9) {
        moder &= ~(3u << 18); /* Input mode = 0 for PA9 */
    }
    GPIOA_MODER = moder;
    if (GPIOA_MODER != moder) {
        return BF_F405_USB_PREPARE_WRITE;
    }

    /* 3. AHB2ENR: Enable OTGFS clock, DSB */
    uint32_t ahb2enr = RCC_AHB2ENR;
    ahb2enr |= (1u << 7);
    RCC_AHB2ENR = ahb2enr;
    if ((RCC_AHB2ENR & (1u << 7)) == 0u) {
        return BF_F405_USB_PREPARE_WRITE;
    }
    __asm__ __volatile__("dsb" ::: "memory");

    /* 4. Pulse AHB2RSTR bit 7: assert, DSB, release, DSB */
    uint32_t ahb2rstr = RCC_AHB2RSTR;
    ahb2rstr |= (1u << 7);
    RCC_AHB2RSTR = ahb2rstr;
    if ((RCC_AHB2RSTR & (1u << 7)) == 0u) {
        return BF_F405_USB_PREPARE_WRITE;
    }
    __asm__ __volatile__("dsb" ::: "memory");

    ahb2rstr &= ~(1u << 7);
    RCC_AHB2RSTR = ahb2rstr;
    if ((RCC_AHB2RSTR & (1u << 7)) != 0u) {
        return BF_F405_USB_PREPARE_WRITE;
    }
    __asm__ __volatile__("dsb" ::: "memory");

    /* 5. NVIC: Disable IRQ, clear pending, set priority */
    NVIC_ICER2 = (1u << 3);
    __asm__ __volatile__("dsb\nisb" ::: "memory");
    if ((NVIC_ISER2 & (1u << 3)) != 0u) {
        return BF_F405_USB_PREPARE_WRITE;
    }

    NVIC_ICPR2 = (1u << 3); /* W1C, do NOT readback */

    NVIC_IPR67 = 0x50u;
    if ((NVIC_IPR67 & 0xF0u) != 0x50u) {
        return BF_F405_USB_PREPARE_WRITE;
    }

    return BF_F405_USB_PREPARE_OK;
}
