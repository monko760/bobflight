/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cortex-M7 startup + vector table for F722/F745. Owned — no ST Cube.
 * OTG_FS (IRQn 67) and SysTick hooked for TinyUSB CDC + time.
 *
 * cdc8: sticky .noinit boot crumb; HardFault blinks N slow (~200 ms) then
 * ~20 Hz forever. MemManage/BusFault/UsageFault share HardFault_Handler.
 */
#include <stdint.h>
#include "boot_crumb.h"

extern int main(void);
extern uint32_t _estack;
extern uint32_t _sidata, _sdata, _edata, _sbss, _ebss;

void Reset_Handler(void);
void Default_Handler(void);
void HardFault_Handler(void);
void SysTick_Handler(void);
void OTG_FS_IRQHandler(void);
void USART1_IRQHandler(void);
void USART2_IRQHandler(void);
void USART3_IRQHandler(void);
void UART4_IRQHandler(void);
void USART6_IRQHandler(void);
void UART7_IRQHandler(void);

/* Sticky crumb — NOT in .bss (survives after BSS clear once Reset seeds it). */
volatile uint8_t g_boot_crumb __attribute__((section(".noinit")));

void boot_crumb_set(uint8_t stage)
{
    g_boot_crumb = stage;
}

void Default_Handler(void)
{
    for (;;) {
    }
}

/* Crude NOP spin — no SysTick / no HAL (safe before main). */
static void early_nop_busywait(volatile uint32_t n)
{
    while (n--) {
        __asm volatile("nop");
    }
}

/*
 * Earliest PA2 setup — crude GPIOA MMIO only (IR-assumed led0 = PA2).
 * No board_* / no HAL.
 */
static void early_pa2_setup(void)
{
    volatile uint32_t *rcc_ahb1enr = (volatile uint32_t *)0x40023830u; /* RCC->AHB1ENR */
    volatile uint32_t *gpioa_moder = (volatile uint32_t *)0x40020000u; /* GPIOA->MODER */

    *rcc_ahb1enr |= (1u << 0); /* GPIOAEN */
    (void)*rcc_ahb1enr;        /* sync delay */
    /* PA2 output: MODER[5:4] = 01 */
    *gpioa_moder = (*gpioa_moder & ~(3u << 4)) | (1u << 4);
}

#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS
/** Crude PA2 short pulse (main-entry / pre-board diagnostic only). */
void boot_pa2_crude_short_pulse(void)
{
    volatile uint32_t *gpioa_odr = (volatile uint32_t *)0x40020014u; /* GPIOA->ODR */

    early_pa2_setup();
    *gpioa_odr |= (1u << 2);
    early_nop_busywait(800000u); /* ~50–80 ms @ HSI ~16 MHz */
    *gpioa_odr &= ~(1u << 2);
    early_nop_busywait(400000u);
    *gpioa_odr |= (1u << 2); /* leave on — known state */
}

#endif

/*
 * HardFault / MemManage / BusFault / UsageFault:
 *   Read sticky crumb N.
 *   N==0 → one special long pulse; else N slow ~200 ms pulses.
 *   Then rapid ~20 Hz forever.
 * Crude GPIOA MMIO only.
 */
void HardFault_Handler(void)
{
    volatile uint32_t *gpioa_odr = (volatile uint32_t *)0x40020014u;
    uint8_t n = g_boot_crumb;
    unsigned i;
    unsigned count;

    early_pa2_setup();

    if (n == 0u) {
        /* Special long (~1 s) — fault before main crumb was set. */
        *gpioa_odr |= (1u << 2);
        early_nop_busywait(10000000u);
        *gpioa_odr &= ~(1u << 2);
        early_nop_busywait(2000000u);
    } else {
        count = (unsigned)n;
        if (count > 15u) {
            count = 15u; /* sanity clamp */
        }
        for (i = 0; i < count; i++) {
            *gpioa_odr |= (1u << 2);
            early_nop_busywait(2000000u); /* ~200 ms half @ HSI */
            *gpioa_odr &= ~(1u << 2);
            early_nop_busywait(2000000u);
        }
    }

    for (;;) {
        *gpioa_odr |= (1u << 2);
        early_nop_busywait(400000u); /* ~20–25 Hz half @ HSI ~16 MHz */
        *gpioa_odr &= ~(1u << 2);
        early_nop_busywait(400000u);
    }
}

#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS && !(defined(BOBFLIGHT_PROVE_RESET) && (BOBFLIGHT_PROVE_RESET))
/*
 * Video-visible Reset prove-out then main.
 * 3 pulses, ~250 ms half-period each (both edges).
 * Leaves LED on so main-entry short pulse / clock encode can take over.
 */
static void early_pa2_blink(void)
{
    volatile uint32_t *gpioa_odr = (volatile uint32_t *)0x40020014u; /* GPIOA->ODR */
    unsigned i;

    early_pa2_setup();

    for (i = 0; i < 3u; i++) {
        *gpioa_odr |= (1u << 2);
        early_nop_busywait(2500000u); /* ~250 ms half @ HSI ~16 MHz */
        *gpioa_odr &= ~(1u << 2);
        early_nop_busywait(2500000u);
    }
    *gpioa_odr |= (1u << 2); /* leave on — known state after Reset prove-out */
}
#endif

#if defined(BOBFLIGHT_PROVE_RESET) && (BOBFLIGHT_PROVE_RESET)
/*
 * cdc6-prove-reset: Reset_Handler-only forever blink (~5–10 Hz @ HSI).
 * Never reaches main / clock / USB. Field: continuous blue blink ⇒ Reset+PA2 OK.
 */
static void prove_reset_pa2_forever(void)
{
    volatile uint32_t *gpioa_odr = (volatile uint32_t *)0x40020014u; /* GPIOA->ODR */

    early_pa2_setup();
    for (;;) {
        *gpioa_odr |= (1u << 2);
        early_nop_busywait(800000u); /* ~half period @ HSI ~16 MHz → ~5–10 Hz */
        *gpioa_odr &= ~(1u << 2);
        early_nop_busywait(800000u);
    }
}
#endif

void Reset_Handler(void)
{
    uint32_t *src = &_sidata;
    uint32_t *dst = &_sdata;
    while (dst < &_edata) {
        *dst++ = *src++;
    }
    dst = &_sbss;
    while (dst < &_ebss) {
        *dst++ = 0;
    }
    /* Seed sticky crumb AFTER BSS clear (so .noinit is not wiped by BSS loop). */
    g_boot_crumb = BOOT_CRUMB_PRE_MAIN;

    /* CP10/CP11 full access — required before any float with -mfloat-abi=hard */
    *((volatile uint32_t *)0xE000ED88) |= (0xFu << 20); /* SCB->CPACR */
    /*
     * After ST DFU, VTOR may still point at ROM. Point at flash vector table
     * (linker places .isr_vector at FLASH origin 0x08000000) before main /
     * SysTick / USB IRQs.
     */
    *((volatile uint32_t *)0xE000ED08) = 0x08000000u; /* SCB->VTOR */
#if defined(BOBFLIGHT_PROVE_RESET) && (BOBFLIGHT_PROVE_RESET)
    prove_reset_pa2_forever(); /* never returns — never main */
#else
#if BOBFLIGHT_BOOT_LED_DIAGNOSTICS
    early_pa2_blink();
#endif
    (void)main();
#endif
    for (;;) {
    }
}

typedef void (*vector_fn)(void);

/*
 * Vector table: system exceptions + external IRQs 0..82.  The receiver can
 * be configured on any supported UART, so every UART IRQ must be present in
 * the table.  Leaving one out makes the CPU fetch an unrelated word after
 * enabling RXNEIE, which looks like a USB disconnect/reset on the bench.
 * MemManage / BusFault / UsageFault → HardFault_Handler (crumb blink).
 * Unused IRQs → Default_Handler. Numbers from RM0431 F74x map.
 */
__attribute__((section(".isr_vector"), used))
static const vector_fn g_vectors[16 + 83] = {
    (vector_fn)(uintptr_t)&_estack,
    Reset_Handler,
    Default_Handler, /* NMI */
    HardFault_Handler, /* HardFault — N slow then ~20 Hz */
    HardFault_Handler, /* MemManage → same crumb blink */
    HardFault_Handler, /* BusFault  → same crumb blink */
    HardFault_Handler, /* UsageFault → same crumb blink */
    0, 0, 0, 0,
    Default_Handler, /* SVCall */
    Default_Handler, /* DebugMon */
    0,
    Default_Handler, /* PendSV */
    SysTick_Handler, /* SysTick */
    /* External IRQ 0..82 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 0-3 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 4-7 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 8-11 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 12-15 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 16-19 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 20-23 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 24-27 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 28-31 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 32-35 */
    Default_Handler, USART1_IRQHandler, USART2_IRQHandler, USART3_IRQHandler, /* 36-39 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 40-43 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 44-47 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 48-51 */
    UART4_IRQHandler, Default_Handler, Default_Handler, Default_Handler, /* 52-55 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 56-59 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 60-63 */
    Default_Handler, Default_Handler, Default_Handler,                 /* 64-66 */
    OTG_FS_IRQHandler, /* 67 OTG_FS */
    Default_Handler, Default_Handler, Default_Handler, /* 68-70 */
    USART6_IRQHandler, /* 71 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 72-75 */
    Default_Handler, Default_Handler, Default_Handler, Default_Handler, /* 76-79 */
    Default_Handler, Default_Handler, /* 80-81 */
    UART7_IRQHandler /* 82 */
};
