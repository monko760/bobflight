/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
/* Isolated exact-part component. Not linked by any hardware backend. */
#include <stdint.h>
#if (defined(BF_F4_COMPONENT_F405XG) + defined(BF_F4_COMPONENT_F411XE)) != 1
#error "Select exactly one verified F4 component density"
#endif
#if !defined(__arm__) || !defined(__thumb__)
#error "F4 startup requires ARM Thumb compilation"
#endif
extern uint32_t _estack, _sidata, _sdata, _edata, _sbss, _ebss;
extern uint32_t _sdma_bss, _edma_bss;
extern void bf_f4_component_entry(void);
void Reset_Handler(void) __attribute__((naked, noreturn, used));
void Default_Handler(void);
void bf_f4_reset_memory(void) __attribute__((noreturn, noinline, used));

void Default_Handler(void) { for (;;) { __asm volatile("nop"); } }
#define WEAK_HANDLER(name) void name(void) __attribute__((weak, alias("Default_Handler")))
WEAK_HANDLER(NMI_Handler);
WEAK_HANDLER(HardFault_Handler);
WEAK_HANDLER(MemManage_Handler);
WEAK_HANDLER(BusFault_Handler);
WEAK_HANDLER(UsageFault_Handler);
WEAK_HANDLER(SVC_Handler);
WEAK_HANDLER(DebugMon_Handler);
WEAK_HANDLER(PendSV_Handler);
WEAK_HANDLER(SysTick_Handler);
#if defined(BF_F4_COMPONENT_F405XG)
__asm__(".global bf_f4_component_part\n.set bf_f4_component_part, 405");
WEAK_HANDLER(WWDG_IRQHandler);
WEAK_HANDLER(PVD_IRQHandler);
WEAK_HANDLER(TAMP_STAMP_IRQHandler);
WEAK_HANDLER(RTC_WKUP_IRQHandler);
WEAK_HANDLER(FLASH_IRQHandler);
WEAK_HANDLER(RCC_IRQHandler);
WEAK_HANDLER(EXTI0_IRQHandler);
WEAK_HANDLER(EXTI1_IRQHandler);
WEAK_HANDLER(EXTI2_IRQHandler);
WEAK_HANDLER(EXTI3_IRQHandler);
WEAK_HANDLER(EXTI4_IRQHandler);
WEAK_HANDLER(DMA1_Stream0_IRQHandler);
WEAK_HANDLER(DMA1_Stream1_IRQHandler);
WEAK_HANDLER(DMA1_Stream2_IRQHandler);
WEAK_HANDLER(DMA1_Stream3_IRQHandler);
WEAK_HANDLER(DMA1_Stream4_IRQHandler);
WEAK_HANDLER(DMA1_Stream5_IRQHandler);
WEAK_HANDLER(DMA1_Stream6_IRQHandler);
WEAK_HANDLER(ADC_IRQHandler);
WEAK_HANDLER(CAN1_TX_IRQHandler);
WEAK_HANDLER(CAN1_RX0_IRQHandler);
WEAK_HANDLER(CAN1_RX1_IRQHandler);
WEAK_HANDLER(CAN1_SCE_IRQHandler);
WEAK_HANDLER(EXTI9_5_IRQHandler);
WEAK_HANDLER(TIM1_BRK_TIM9_IRQHandler);
WEAK_HANDLER(TIM1_UP_TIM10_IRQHandler);
WEAK_HANDLER(TIM1_TRG_COM_TIM11_IRQHandler);
WEAK_HANDLER(TIM1_CC_IRQHandler);
WEAK_HANDLER(TIM2_IRQHandler);
WEAK_HANDLER(TIM3_IRQHandler);
WEAK_HANDLER(TIM4_IRQHandler);
WEAK_HANDLER(I2C1_EV_IRQHandler);
WEAK_HANDLER(I2C1_ER_IRQHandler);
WEAK_HANDLER(I2C2_EV_IRQHandler);
WEAK_HANDLER(I2C2_ER_IRQHandler);
WEAK_HANDLER(SPI1_IRQHandler);
WEAK_HANDLER(SPI2_IRQHandler);
WEAK_HANDLER(USART1_IRQHandler);
WEAK_HANDLER(USART2_IRQHandler);
WEAK_HANDLER(USART3_IRQHandler);
WEAK_HANDLER(EXTI15_10_IRQHandler);
WEAK_HANDLER(RTC_Alarm_IRQHandler);
WEAK_HANDLER(OTG_FS_WKUP_IRQHandler);
WEAK_HANDLER(TIM8_BRK_TIM12_IRQHandler);
WEAK_HANDLER(TIM8_UP_TIM13_IRQHandler);
WEAK_HANDLER(TIM8_TRG_COM_TIM14_IRQHandler);
WEAK_HANDLER(TIM8_CC_IRQHandler);
WEAK_HANDLER(DMA1_Stream7_IRQHandler);
WEAK_HANDLER(FSMC_IRQHandler);
WEAK_HANDLER(SDIO_IRQHandler);
WEAK_HANDLER(TIM5_IRQHandler);
WEAK_HANDLER(SPI3_IRQHandler);
WEAK_HANDLER(UART4_IRQHandler);
WEAK_HANDLER(UART5_IRQHandler);
WEAK_HANDLER(TIM6_DAC_IRQHandler);
WEAK_HANDLER(TIM7_IRQHandler);
WEAK_HANDLER(DMA2_Stream0_IRQHandler);
WEAK_HANDLER(DMA2_Stream1_IRQHandler);
WEAK_HANDLER(DMA2_Stream2_IRQHandler);
WEAK_HANDLER(DMA2_Stream3_IRQHandler);
WEAK_HANDLER(DMA2_Stream4_IRQHandler);
WEAK_HANDLER(CAN2_TX_IRQHandler);
WEAK_HANDLER(CAN2_RX0_IRQHandler);
WEAK_HANDLER(CAN2_RX1_IRQHandler);
WEAK_HANDLER(CAN2_SCE_IRQHandler);
WEAK_HANDLER(OTG_FS_IRQHandler);
WEAK_HANDLER(DMA2_Stream5_IRQHandler);
WEAK_HANDLER(DMA2_Stream6_IRQHandler);
WEAK_HANDLER(DMA2_Stream7_IRQHandler);
WEAK_HANDLER(USART6_IRQHandler);
WEAK_HANDLER(I2C3_EV_IRQHandler);
WEAK_HANDLER(I2C3_ER_IRQHandler);
WEAK_HANDLER(OTG_HS_EP1_OUT_IRQHandler);
WEAK_HANDLER(OTG_HS_EP1_IN_IRQHandler);
WEAK_HANDLER(OTG_HS_WKUP_IRQHandler);
WEAK_HANDLER(OTG_HS_IRQHandler);
WEAK_HANDLER(RNG_IRQHandler);
WEAK_HANDLER(FPU_IRQHandler);
__attribute__((section(".isr_vector"), used, aligned(512)))
const uintptr_t bf_f4_vectors[98] = {
    [0] = (uintptr_t)&_estack, [1] = (uintptr_t)Reset_Handler,
    [2] = (uintptr_t)NMI_Handler,
    [3] = (uintptr_t)HardFault_Handler,
    [4] = (uintptr_t)MemManage_Handler,
    [5] = (uintptr_t)BusFault_Handler,
    [6] = (uintptr_t)UsageFault_Handler,
    [11] = (uintptr_t)SVC_Handler,
    [12] = (uintptr_t)DebugMon_Handler,
    [14] = (uintptr_t)PendSV_Handler,
    [15] = (uintptr_t)SysTick_Handler,
    [16] = (uintptr_t)WWDG_IRQHandler,
    [17] = (uintptr_t)PVD_IRQHandler,
    [18] = (uintptr_t)TAMP_STAMP_IRQHandler,
    [19] = (uintptr_t)RTC_WKUP_IRQHandler,
    [20] = (uintptr_t)FLASH_IRQHandler,
    [21] = (uintptr_t)RCC_IRQHandler,
    [22] = (uintptr_t)EXTI0_IRQHandler,
    [23] = (uintptr_t)EXTI1_IRQHandler,
    [24] = (uintptr_t)EXTI2_IRQHandler,
    [25] = (uintptr_t)EXTI3_IRQHandler,
    [26] = (uintptr_t)EXTI4_IRQHandler,
    [27] = (uintptr_t)DMA1_Stream0_IRQHandler,
    [28] = (uintptr_t)DMA1_Stream1_IRQHandler,
    [29] = (uintptr_t)DMA1_Stream2_IRQHandler,
    [30] = (uintptr_t)DMA1_Stream3_IRQHandler,
    [31] = (uintptr_t)DMA1_Stream4_IRQHandler,
    [32] = (uintptr_t)DMA1_Stream5_IRQHandler,
    [33] = (uintptr_t)DMA1_Stream6_IRQHandler,
    [34] = (uintptr_t)ADC_IRQHandler,
    [35] = (uintptr_t)CAN1_TX_IRQHandler,
    [36] = (uintptr_t)CAN1_RX0_IRQHandler,
    [37] = (uintptr_t)CAN1_RX1_IRQHandler,
    [38] = (uintptr_t)CAN1_SCE_IRQHandler,
    [39] = (uintptr_t)EXTI9_5_IRQHandler,
    [40] = (uintptr_t)TIM1_BRK_TIM9_IRQHandler,
    [41] = (uintptr_t)TIM1_UP_TIM10_IRQHandler,
    [42] = (uintptr_t)TIM1_TRG_COM_TIM11_IRQHandler,
    [43] = (uintptr_t)TIM1_CC_IRQHandler,
    [44] = (uintptr_t)TIM2_IRQHandler,
    [45] = (uintptr_t)TIM3_IRQHandler,
    [46] = (uintptr_t)TIM4_IRQHandler,
    [47] = (uintptr_t)I2C1_EV_IRQHandler,
    [48] = (uintptr_t)I2C1_ER_IRQHandler,
    [49] = (uintptr_t)I2C2_EV_IRQHandler,
    [50] = (uintptr_t)I2C2_ER_IRQHandler,
    [51] = (uintptr_t)SPI1_IRQHandler,
    [52] = (uintptr_t)SPI2_IRQHandler,
    [53] = (uintptr_t)USART1_IRQHandler,
    [54] = (uintptr_t)USART2_IRQHandler,
    [55] = (uintptr_t)USART3_IRQHandler,
    [56] = (uintptr_t)EXTI15_10_IRQHandler,
    [57] = (uintptr_t)RTC_Alarm_IRQHandler,
    [58] = (uintptr_t)OTG_FS_WKUP_IRQHandler,
    [59] = (uintptr_t)TIM8_BRK_TIM12_IRQHandler,
    [60] = (uintptr_t)TIM8_UP_TIM13_IRQHandler,
    [61] = (uintptr_t)TIM8_TRG_COM_TIM14_IRQHandler,
    [62] = (uintptr_t)TIM8_CC_IRQHandler,
    [63] = (uintptr_t)DMA1_Stream7_IRQHandler,
    [64] = (uintptr_t)FSMC_IRQHandler,
    [65] = (uintptr_t)SDIO_IRQHandler,
    [66] = (uintptr_t)TIM5_IRQHandler,
    [67] = (uintptr_t)SPI3_IRQHandler,
    [68] = (uintptr_t)UART4_IRQHandler,
    [69] = (uintptr_t)UART5_IRQHandler,
    [70] = (uintptr_t)TIM6_DAC_IRQHandler,
    [71] = (uintptr_t)TIM7_IRQHandler,
    [72] = (uintptr_t)DMA2_Stream0_IRQHandler,
    [73] = (uintptr_t)DMA2_Stream1_IRQHandler,
    [74] = (uintptr_t)DMA2_Stream2_IRQHandler,
    [75] = (uintptr_t)DMA2_Stream3_IRQHandler,
    [76] = (uintptr_t)DMA2_Stream4_IRQHandler,
    [79] = (uintptr_t)CAN2_TX_IRQHandler,
    [80] = (uintptr_t)CAN2_RX0_IRQHandler,
    [81] = (uintptr_t)CAN2_RX1_IRQHandler,
    [82] = (uintptr_t)CAN2_SCE_IRQHandler,
    [83] = (uintptr_t)OTG_FS_IRQHandler,
    [84] = (uintptr_t)DMA2_Stream5_IRQHandler,
    [85] = (uintptr_t)DMA2_Stream6_IRQHandler,
    [86] = (uintptr_t)DMA2_Stream7_IRQHandler,
    [87] = (uintptr_t)USART6_IRQHandler,
    [88] = (uintptr_t)I2C3_EV_IRQHandler,
    [89] = (uintptr_t)I2C3_ER_IRQHandler,
    [90] = (uintptr_t)OTG_HS_EP1_OUT_IRQHandler,
    [91] = (uintptr_t)OTG_HS_EP1_IN_IRQHandler,
    [92] = (uintptr_t)OTG_HS_WKUP_IRQHandler,
    [93] = (uintptr_t)OTG_HS_IRQHandler,
    [96] = (uintptr_t)RNG_IRQHandler,
    [97] = (uintptr_t)FPU_IRQHandler,
}; /* Unspecified reserved slots are zero. */
#endif
#if defined(BF_F4_COMPONENT_F411XE)
__asm__(".global bf_f4_component_part\n.set bf_f4_component_part, 411");
WEAK_HANDLER(WWDG_IRQHandler);
WEAK_HANDLER(PVD_IRQHandler);
WEAK_HANDLER(TAMP_STAMP_IRQHandler);
WEAK_HANDLER(RTC_WKUP_IRQHandler);
WEAK_HANDLER(FLASH_IRQHandler);
WEAK_HANDLER(RCC_IRQHandler);
WEAK_HANDLER(EXTI0_IRQHandler);
WEAK_HANDLER(EXTI1_IRQHandler);
WEAK_HANDLER(EXTI2_IRQHandler);
WEAK_HANDLER(EXTI3_IRQHandler);
WEAK_HANDLER(EXTI4_IRQHandler);
WEAK_HANDLER(DMA1_Stream0_IRQHandler);
WEAK_HANDLER(DMA1_Stream1_IRQHandler);
WEAK_HANDLER(DMA1_Stream2_IRQHandler);
WEAK_HANDLER(DMA1_Stream3_IRQHandler);
WEAK_HANDLER(DMA1_Stream4_IRQHandler);
WEAK_HANDLER(DMA1_Stream5_IRQHandler);
WEAK_HANDLER(DMA1_Stream6_IRQHandler);
WEAK_HANDLER(ADC_IRQHandler);
WEAK_HANDLER(EXTI9_5_IRQHandler);
WEAK_HANDLER(TIM1_BRK_TIM9_IRQHandler);
WEAK_HANDLER(TIM1_UP_TIM10_IRQHandler);
WEAK_HANDLER(TIM1_TRG_COM_TIM11_IRQHandler);
WEAK_HANDLER(TIM1_CC_IRQHandler);
WEAK_HANDLER(TIM2_IRQHandler);
WEAK_HANDLER(TIM3_IRQHandler);
WEAK_HANDLER(TIM4_IRQHandler);
WEAK_HANDLER(I2C1_EV_IRQHandler);
WEAK_HANDLER(I2C1_ER_IRQHandler);
WEAK_HANDLER(I2C2_EV_IRQHandler);
WEAK_HANDLER(I2C2_ER_IRQHandler);
WEAK_HANDLER(SPI1_IRQHandler);
WEAK_HANDLER(SPI2_IRQHandler);
WEAK_HANDLER(USART1_IRQHandler);
WEAK_HANDLER(USART2_IRQHandler);
WEAK_HANDLER(EXTI15_10_IRQHandler);
WEAK_HANDLER(RTC_Alarm_IRQHandler);
WEAK_HANDLER(OTG_FS_WKUP_IRQHandler);
WEAK_HANDLER(DMA1_Stream7_IRQHandler);
WEAK_HANDLER(SDIO_IRQHandler);
WEAK_HANDLER(TIM5_IRQHandler);
WEAK_HANDLER(SPI3_IRQHandler);
WEAK_HANDLER(DMA2_Stream0_IRQHandler);
WEAK_HANDLER(DMA2_Stream1_IRQHandler);
WEAK_HANDLER(DMA2_Stream2_IRQHandler);
WEAK_HANDLER(DMA2_Stream3_IRQHandler);
WEAK_HANDLER(DMA2_Stream4_IRQHandler);
WEAK_HANDLER(OTG_FS_IRQHandler);
WEAK_HANDLER(DMA2_Stream5_IRQHandler);
WEAK_HANDLER(DMA2_Stream6_IRQHandler);
WEAK_HANDLER(DMA2_Stream7_IRQHandler);
WEAK_HANDLER(USART6_IRQHandler);
WEAK_HANDLER(I2C3_EV_IRQHandler);
WEAK_HANDLER(I2C3_ER_IRQHandler);
WEAK_HANDLER(FPU_IRQHandler);
WEAK_HANDLER(SPI4_IRQHandler);
WEAK_HANDLER(SPI5_IRQHandler);
__attribute__((section(".isr_vector"), used, aligned(512)))
const uintptr_t bf_f4_vectors[102] = {
    [0] = (uintptr_t)&_estack, [1] = (uintptr_t)Reset_Handler,
    [2] = (uintptr_t)NMI_Handler,
    [3] = (uintptr_t)HardFault_Handler,
    [4] = (uintptr_t)MemManage_Handler,
    [5] = (uintptr_t)BusFault_Handler,
    [6] = (uintptr_t)UsageFault_Handler,
    [11] = (uintptr_t)SVC_Handler,
    [12] = (uintptr_t)DebugMon_Handler,
    [14] = (uintptr_t)PendSV_Handler,
    [15] = (uintptr_t)SysTick_Handler,
    [16] = (uintptr_t)WWDG_IRQHandler,
    [17] = (uintptr_t)PVD_IRQHandler,
    [18] = (uintptr_t)TAMP_STAMP_IRQHandler,
    [19] = (uintptr_t)RTC_WKUP_IRQHandler,
    [20] = (uintptr_t)FLASH_IRQHandler,
    [21] = (uintptr_t)RCC_IRQHandler,
    [22] = (uintptr_t)EXTI0_IRQHandler,
    [23] = (uintptr_t)EXTI1_IRQHandler,
    [24] = (uintptr_t)EXTI2_IRQHandler,
    [25] = (uintptr_t)EXTI3_IRQHandler,
    [26] = (uintptr_t)EXTI4_IRQHandler,
    [27] = (uintptr_t)DMA1_Stream0_IRQHandler,
    [28] = (uintptr_t)DMA1_Stream1_IRQHandler,
    [29] = (uintptr_t)DMA1_Stream2_IRQHandler,
    [30] = (uintptr_t)DMA1_Stream3_IRQHandler,
    [31] = (uintptr_t)DMA1_Stream4_IRQHandler,
    [32] = (uintptr_t)DMA1_Stream5_IRQHandler,
    [33] = (uintptr_t)DMA1_Stream6_IRQHandler,
    [34] = (uintptr_t)ADC_IRQHandler,
    [39] = (uintptr_t)EXTI9_5_IRQHandler,
    [40] = (uintptr_t)TIM1_BRK_TIM9_IRQHandler,
    [41] = (uintptr_t)TIM1_UP_TIM10_IRQHandler,
    [42] = (uintptr_t)TIM1_TRG_COM_TIM11_IRQHandler,
    [43] = (uintptr_t)TIM1_CC_IRQHandler,
    [44] = (uintptr_t)TIM2_IRQHandler,
    [45] = (uintptr_t)TIM3_IRQHandler,
    [46] = (uintptr_t)TIM4_IRQHandler,
    [47] = (uintptr_t)I2C1_EV_IRQHandler,
    [48] = (uintptr_t)I2C1_ER_IRQHandler,
    [49] = (uintptr_t)I2C2_EV_IRQHandler,
    [50] = (uintptr_t)I2C2_ER_IRQHandler,
    [51] = (uintptr_t)SPI1_IRQHandler,
    [52] = (uintptr_t)SPI2_IRQHandler,
    [53] = (uintptr_t)USART1_IRQHandler,
    [54] = (uintptr_t)USART2_IRQHandler,
    [56] = (uintptr_t)EXTI15_10_IRQHandler,
    [57] = (uintptr_t)RTC_Alarm_IRQHandler,
    [58] = (uintptr_t)OTG_FS_WKUP_IRQHandler,
    [63] = (uintptr_t)DMA1_Stream7_IRQHandler,
    [65] = (uintptr_t)SDIO_IRQHandler,
    [66] = (uintptr_t)TIM5_IRQHandler,
    [67] = (uintptr_t)SPI3_IRQHandler,
    [72] = (uintptr_t)DMA2_Stream0_IRQHandler,
    [73] = (uintptr_t)DMA2_Stream1_IRQHandler,
    [74] = (uintptr_t)DMA2_Stream2_IRQHandler,
    [75] = (uintptr_t)DMA2_Stream3_IRQHandler,
    [76] = (uintptr_t)DMA2_Stream4_IRQHandler,
    [83] = (uintptr_t)OTG_FS_IRQHandler,
    [84] = (uintptr_t)DMA2_Stream5_IRQHandler,
    [85] = (uintptr_t)DMA2_Stream6_IRQHandler,
    [86] = (uintptr_t)DMA2_Stream7_IRQHandler,
    [87] = (uintptr_t)USART6_IRQHandler,
    [88] = (uintptr_t)I2C3_EV_IRQHandler,
    [89] = (uintptr_t)I2C3_ER_IRQHandler,
    [97] = (uintptr_t)FPU_IRQHandler,
    [100] = (uintptr_t)SPI4_IRQHandler,
    [101] = (uintptr_t)SPI5_IRQHandler,
}; /* Unspecified reserved slots are zero. */
#endif

/* No compiler-generated C prologue or hard-float operation precedes CPACR.
 * Interrupts remain masked for the component entry to manage after real HAL init. */
void Reset_Handler(void)
{
    __asm volatile(
        "cpsid i\n"
        "ldr r0, =0xe000ed88\n"
        "ldr r1, [r0]\n"
        "orr r1, r1, #0x00f00000\n"
        "str r1, [r0]\n"
        "dsb sy\n"
        "isb sy\n"
        "ldr r0, =0xe000ed08\n"
        "ldr r1, =bf_f4_vectors\n"
        "str r1, [r0]\n"
        "dsb sy\n"
        "isb sy\n"
        "b.w bf_f4_reset_memory\n");
}

void bf_f4_reset_memory(void)
{
    const volatile uint32_t *src = &_sidata;
    for (volatile uint32_t *dst = &_sdata; dst < &_edata; ++dst) *dst = *src++;
    for (volatile uint32_t *dst = &_sbss; dst < &_ebss; ++dst) *dst = 0;
    for (volatile uint32_t *dst = &_sdma_bss; dst < &_edma_bss; ++dst) *dst = 0;
    /* .noinit and explicitly uninitialized CCM scratch are intentionally untouched. */
    bf_f4_component_entry();
    Default_Handler();
    for (;;) { /* Entry must never resume startup. */ }
}
