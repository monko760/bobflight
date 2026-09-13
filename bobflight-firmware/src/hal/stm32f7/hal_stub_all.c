/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Minimal STM32F722 HAL no-ops so the firmware *links* for the skeleton
 * without vendoring CMSIS/STM32Cube yet. Replace per-file under stm32f7/
 * when third_party CMSIS (Apache) is audited in.
 */
#include "hal/hal.h"

#include <string.h>

#if !defined(BOBFLIGHT_HOST)

static uint32_t g_ms;
static uint64_t g_us;

void hal_clock_init(uint32_t hse_mhz) { (void)hse_mhz; }
uint32_t hal_core_clock_hz(void){return 0;}
bool hal_time_high_resolution(void){return false;}
const char *hal_time_source(void){return "simulated";}
void hal_time_init(void) { g_ms = 0; g_us = 0; }
uint32_t hal_millis(void) { return g_ms; }
uint64_t hal_micros(void) { return g_us; }
void hal_delay_ms(uint32_t ms) { g_ms += ms; g_us += (uint64_t)ms * 1000ull; }

void hal_gpio_init(hal_pin_t pin, hal_gpio_mode_t mode) { (void)pin; (void)mode; }
void hal_gpio_write(hal_pin_t pin, bool high) { (void)pin; (void)high; }
bool hal_gpio_read(hal_pin_t pin) { (void)pin; return false; }

struct hal_spi_bus { int dummy; };
hal_spi_bus_t *hal_spi_open(unsigned bus_index) { (void)bus_index; return NULL; }
bool hal_spi_transfer(hal_spi_bus_t *bus, hal_pin_t cs, const uint8_t *tx, uint8_t *rx, size_t len)
{
    (void)bus; (void)cs; (void)tx;
    if (rx && len) memset(rx, 0, len);
    return false;
}

struct hal_uart { int dummy; };
hal_uart_t *hal_uart_open(unsigned instance, uint32_t baud) { (void)instance; (void)baud; return NULL; }
size_t hal_uart_read(hal_uart_t *u, uint8_t *buf, size_t maxlen) { (void)u; (void)buf; (void)maxlen; return 0; }
size_t hal_uart_write(hal_uart_t *u, const uint8_t *buf, size_t len) { (void)u; (void)buf; return len; }

struct hal_tim_dma { int dummy; };
hal_tim_dma_t *hal_tim_dma_open(unsigned tim, unsigned channel) { (void)tim; (void)channel; return NULL; }
bool hal_tim_dma_start_burst(hal_tim_dma_t *t, const uint16_t *words, size_t n)
{ (void)t; (void)words; (void)n; return false; }

bool hal_exti_attach(hal_pin_t pin, hal_exti_cb_t cb, void *ctx)
{ (void)pin; (void)cb; (void)ctx; return false; }

bool hal_usb_cdc_init(void) { return false; }
size_t hal_usb_cdc_read(uint8_t *buf, size_t maxlen) { (void)buf; (void)maxlen; return 0; }
size_t hal_usb_cdc_write(const uint8_t *buf, size_t len) { (void)buf; return len; }
bool hal_usb_cdc_connected(void) { return false; }

bool hal_flash_supported(void){return false;}
const char *hal_flash_backend(void){return "unsupported";}
bool hal_flash_erase_slot(unsigned slot){(void)slot;return false;}
bool hal_flash_read(uint32_t offset, void *dst, size_t len)
{ (void)offset; if (dst && len) memset(dst, 0xff, len); return false; }
bool hal_flash_write(uint32_t offset, const void *src, size_t len)
{ (void)offset; (void)src; (void)len; return false; }

/* Advance dummy time so a bare-metal scheduler loop can progress in sim. */
void hal_stub_advance_us(uint32_t us) { g_us += us; g_ms = (uint32_t)(g_us / 1000ull); }

#endif /* !BOBFLIGHT_HOST */
