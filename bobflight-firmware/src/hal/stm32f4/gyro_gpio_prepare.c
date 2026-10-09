/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "gyro_gpio_prepare.h"

#if !defined(__arm__) || !defined(__thumb__)
#error "gyro_gpio_prepare requires ARM Thumb target compilation"
#endif

#if !defined(BF_F4_COMPONENT_F405XG)
#error "BF_F4_COMPONENT_F405XG must be defined for gyro_gpio_prepare"
#endif

#if defined(BF_F4_COMPONENT_F411XE)
#error "BF_F4_COMPONENT_F411XE must NOT be defined for gyro_gpio_prepare"
#endif

#define RCC_AHB1ENR   (*(volatile uint32_t *)0x40023830u)

#define GPIOA_MODER   (*(volatile uint32_t *)0x40020000u)
#define GPIOA_OTYPER  (*(volatile uint32_t *)0x40020004u)
#define GPIOA_OSPEEDR (*(volatile uint32_t *)0x40020008u)
#define GPIOA_PUPDR   (*(volatile uint32_t *)0x4002000Cu)
#define GPIOA_ODR     (*(volatile uint32_t *)0x40020014u)
#define GPIOA_BSRR    (*(volatile uint32_t *)0x40020018u)
#define GPIOA_AFRL    (*(volatile uint32_t *)0x40020020u)

#define GPIOC_MODER   (*(volatile uint32_t *)0x40020800u)
#define GPIOC_PUPDR   (*(volatile uint32_t *)0x4002080Cu)

static bool s_attempted = false;
static bool s_prepared = false;

bf_f405_gyro_gpio_status_t bf_f405_gyro_gpio_prepare(const board_t *board)
{
    uint32_t ipsr = 0u;
    __asm__ __volatile__("mrs %0, ipsr" : "=r"(ipsr));
    if (ipsr != 0u) {
        return BF_F405_GYRO_GPIO_ERR_CONTEXT;
    }

    uint32_t primask = 0u;
    __asm__ __volatile__("mrs %0, primask" : "=r"(primask));
    if ((primask & 1u) == 0u) {
        return BF_F405_GYRO_GPIO_ERR_CONTEXT;
    }

    if (s_attempted) {
        return BF_F405_GYRO_GPIO_ERR_ALREADY;
    }

    if (!board || board->gyro_spi_bus != 1u ||
        board->gyro_cs_pin   != HAL_PIN_PACK(0, 4) ||
        board->gyro_sck_pin  != HAL_PIN_PACK(0, 5) ||
        board->gyro_miso_pin != HAL_PIN_PACK(0, 6) ||
        board->gyro_mosi_pin != HAL_PIN_PACK(0, 7) ||
        board->gyro_exti_pin != HAL_PIN_PACK(2, 5)) {
        return BF_F405_GYRO_GPIO_ERR_INVALID;
    }

    s_attempted = true;

    /* 1. Enable GPIOA (bit 0) and GPIOC (bit 2) clocks in RCC_AHB1ENR */
    uint32_t ahb1enr = RCC_AHB1ENR;
    ahb1enr |= (1u << 0) | (1u << 2);
    RCC_AHB1ENR = ahb1enr;
    __asm__ __volatile__("dsb" ::: "memory");
    if ((RCC_AHB1ENR & ((1u << 0) | (1u << 2))) != ((1u << 0) | (1u << 2))) {
        return BF_F405_GYRO_GPIO_ERR_WRITE;
    }

    /* 2. Configure GPIOA Alternate Function AF5 for PA5 (SCK), PA6 (MISO), PA7 (MOSI) */
    uint32_t afrl = GPIOA_AFRL;
    afrl = (afrl & ~0xFFF00000u) | (5u << 20) | (5u << 24) | (5u << 28);
    GPIOA_AFRL = afrl;
    if (GPIOA_AFRL != afrl) {
        return BF_F405_GYRO_GPIO_ERR_WRITE;
    }

    /* 3. Configure GPIOA Output Type: Push-Pull for PA4..PA7 */
    uint32_t otyper = GPIOA_OTYPER;
    otyper &= ~((1u << 4) | (1u << 5) | (1u << 6) | (1u << 7));
    GPIOA_OTYPER = otyper;
    if (GPIOA_OTYPER != otyper) {
        return BF_F405_GYRO_GPIO_ERR_WRITE;
    }

    /* 4. High-speed SPI pads, low-speed CS. Preserve unrelated pads. */
    uint32_t ospeedr = GPIOA_OSPEEDR;
    ospeedr = (ospeedr & ~0x0000FF00u) | (2u << 10) | (2u << 12) | (2u << 14);
    GPIOA_OSPEEDR = ospeedr;
    if (GPIOA_OSPEEDR != ospeedr) {
        return BF_F405_GYRO_GPIO_ERR_WRITE;
    }

    /* 5. Configure GPIOA Pull-up/Pull-down: No Pull for PA4..PA7 */
    uint32_t pupdr = GPIOA_PUPDR;
    pupdr &= ~((3u << 8) | (3u << 10) | (3u << 12) | (3u << 14));
    GPIOA_PUPDR = pupdr;
    if (GPIOA_PUPDR != pupdr) {
        return BF_F405_GYRO_GPIO_ERR_WRITE;
    }

    /* 6. Preload PA4 HIGH in BSRR BEFORE switching PA4 to Output mode in MODER */
    GPIOA_BSRR = (1u << 4);
    if ((GPIOA_ODR & (1u << 4)) == 0u) {
        return BF_F405_GYRO_GPIO_ERR_WRITE;
    }

    /* 7. Configure GPIOA MODER: PA4=Output(01), PA5..PA7=AF(10) */
    uint32_t moder = GPIOA_MODER;
    moder = (moder & ~0x0000FF00u) | (1u << 8) | (2u << 10) | (2u << 12) | (2u << 14);
    GPIOA_MODER = moder;
    if (GPIOA_MODER != moder) {
        return BF_F405_GYRO_GPIO_ERR_WRITE;
    }

    /* 8. Configure GPIOC for PC5 (DRDY): Input mode (00), No Pull */
    uint32_t c_pupdr = GPIOC_PUPDR;
    c_pupdr &= ~(3u << 10);
    GPIOC_PUPDR = c_pupdr;
    if (GPIOC_PUPDR != c_pupdr) {
        return BF_F405_GYRO_GPIO_ERR_WRITE;
    }

    uint32_t c_moder = GPIOC_MODER;
    c_moder &= ~(3u << 10);
    GPIOC_MODER = c_moder;
    if (GPIOC_MODER != c_moder) {
        return BF_F405_GYRO_GPIO_ERR_WRITE;
    }

    s_prepared = true;
    return BF_F405_GYRO_GPIO_OK;
}

void bf_f405_gyro_cs_cb(void *ctx, bool assert_cs)
{
    if (ctx != NULL || !s_prepared) return;
    uint32_t ipsr;
    __asm__ __volatile__("mrs %0, ipsr" : "=r"(ipsr));
    if (ipsr != 0u) return;
    if (assert_cs) {
        GPIOA_BSRR = (1u << 20); /* Reset PA4 => LOW */
    } else {
        GPIOA_BSRR = (1u << 4);  /* Set PA4 => HIGH */
    }
}
