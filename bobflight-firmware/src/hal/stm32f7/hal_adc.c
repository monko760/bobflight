/* SPDX-License-Identifier: Apache-2.0
 * STM32F745 RM0385 section 15. ADC1 single software conversions,
 * no DMA or interrupt changes; polling never waits for conversion completion.
 */
#include "hal/stm32f7/hal_f7_priv.h"
#include "board/board.h"
typedef struct {
    volatile uint32_t SR, CR1, CR2, SMPR1, SMPR2, JOFR[4], HTR, LTR;
    volatile uint32_t SQR1, SQR2, SQR3, JSQR, JDR[4], DR;
} adc_regs_t;
_Static_assert(offsetof(adc_regs_t, DR)==0x4c, "ADC DR layout");
#define ADC1 ((adc_regs_t *)(uintptr_t)0x40012000u)
#define ADC_CCR (*(volatile uint32_t *)(uintptr_t)0x40012304u)
static bool enabled;
static unsigned phase;
static uint32_t started, cycle;
static uint16_t vbat;
void hal_power_adc_init(hal_pin_t voltage, hal_pin_t current) {
    enabled=false; phase=0;
    /* Only audited F745 PC3/IN13 and PC2/IN12 mappings are supported. */
    if (!board_mmio_permitted() || voltage!=HAL_PIN_PACK(2,3) || current!=HAL_PIN_PACK(2,2)) return;
    hal_f7_rcc_gpio_enable(2);
    hal_f7_gpio_regs_t *gpio=hal_f7_gpio(2);
    gpio->MODER |= (3u<<6)|(3u<<4);
    gpio->PUPDR &= ~((3u<<6)|(3u<<4));
    HAL_F7_RCC->APB2ENR |= 1u<<8;
    (void)HAL_F7_RCC->APB2ENR;
    ADC1->CR2=0; ADC1->CR1=0;
    /* PCLK2 / 8 stays below 36 MHz even at maximum supported clock. */
    ADC_CCR=(ADC_CCR & ~(3u<<16)) | (3u<<16);
    ADC1->SMPR1=(7u<<9)|(7u<<6); /* 480 cycles for channels 13/12. */
    ADC1->SQR1=0; ADC1->SQR2=0; ADC1->SQR3=13;
    ADC1->SR=0; ADC1->CR2=1; /* ADON; first conversion delayed >=50ms. */
    cycle=hal_millis(); enabled=true;
}
bool hal_power_adc_poll(uint16_t *voltage, uint16_t *current) {
    if (!enabled || !voltage || !current) return false;
    uint32_t now=hal_millis();
    if (!phase) {
        if ((uint32_t)(now-cycle)<50u) return false;
        cycle=now; started=now; phase=1;
        ADC1->SR=0; ADC1->SQR3=13; ADC1->CR2 |= 1u<<30;
        return false;
    }
    if ((uint32_t)(now-started)>10u) {
        ADC1->CR2=0; ADC1->SR=0; ADC1->CR2=1; phase=0;
        return false;
    }
    if (!(ADC1->SR & (1u<<1))) return false;
    uint16_t value=(uint16_t)ADC1->DR;
    if (phase==1) {
        vbat=value; phase=2; started=now;
        ADC1->SR=0; ADC1->SQR3=12; ADC1->CR2 |= 1u<<30;
        return false;
    }
    *voltage=vbat; *current=value; phase=0;
    return true;
}
