/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Abstract HAL — buses and peripherals only. No board pins here.
 * Pin numbers arrive as opaque handles from board_t / IR codegen.
 */
#ifndef BOBFLIGHT_HAL_H
#define BOBFLIGHT_HAL_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef uint16_t hal_pin_t;
#define HAL_PIN_INVALID ((hal_pin_t)0xFFFFu)

/* MCU-generic pack: port 0=A .. 10=K, pin 0..15.
 * Drivers never call HAL_PIN_PACK with literals — IR / board_t only. */
#define HAL_PIN_PACK(port, num) \
    ((hal_pin_t)(((((unsigned)(port)) & 0x0Fu) << 4) | (((unsigned)(num)) & 0x0Fu)))
#define HAL_PIN_PORT(p) ((unsigned)(((p) >> 4) & 0x0Fu))
#define HAL_PIN_NUM(p)  ((unsigned)((p) & 0x0Fu))

static inline bool hal_pin_valid(hal_pin_t pin)
{
    return pin != HAL_PIN_INVALID;
}

/* ---- time / clock ---- */
void hal_clock_init(uint32_t hse_mhz); /* 0 = host / HSI stub */
/** USB/SYSCLK source tag: "hse-pll" | "hsi-pll" | "hsi-raw" | "host". */
const char *hal_clock_usb_src(void);
void hal_time_init(void);
uint32_t hal_millis(void);
uint64_t hal_micros(void);
void hal_delay_ms(uint32_t ms);

/* ---- GPIO ---- */
typedef enum {
    HAL_GPIO_IN = 0,
    HAL_GPIO_OUT,
    HAL_GPIO_AF
} hal_gpio_mode_t;

typedef enum {
    HAL_GPIO_PULL_NONE = 0,
    HAL_GPIO_PULL_UP,
    HAL_GPIO_PULL_DOWN
} hal_gpio_pull_t;

typedef enum {
    HAL_GPIO_SPEED_LOW = 0,
    HAL_GPIO_SPEED_MED,
    HAL_GPIO_SPEED_HIGH,
    HAL_GPIO_SPEED_VERYHIGH
} hal_gpio_speed_t;

typedef struct {
    hal_gpio_mode_t  mode;
    hal_gpio_pull_t  pull;
    hal_gpio_speed_t speed;
    uint8_t          af; /* 0 if unused */
} hal_gpio_cfg_t;

void hal_gpio_init(hal_pin_t pin, hal_gpio_mode_t mode);
bool hal_gpio_configure(hal_pin_t pin, const hal_gpio_cfg_t *cfg);
void hal_gpio_write(hal_pin_t pin, bool high);
bool hal_gpio_read(hal_pin_t pin);

/* ---- SPI ---- */
typedef struct hal_spi_bus hal_spi_bus_t;

typedef struct {
    unsigned bus_index; /* 1..N from board IR */
    uint32_t hz;
    uint8_t  cpol;
    uint8_t  cpha;
    uint8_t  bits; /* 8 typical */
} hal_spi_cfg_t;

hal_spi_bus_t *hal_spi_open(unsigned bus_index);
hal_spi_bus_t *hal_spi_open_cfg(const hal_spi_cfg_t *cfg);
bool hal_spi_transfer(hal_spi_bus_t *bus, hal_pin_t cs,
                      const uint8_t *tx, uint8_t *rx, size_t len);

/* ---- UART ---- */
typedef struct hal_uart hal_uart_t;

typedef struct {
    unsigned  instance; /* 1..N; 0 invalid */
    uint32_t  baud;
    hal_pin_t rx;
    hal_pin_t tx;
} hal_uart_cfg_t;

hal_uart_t *hal_uart_open(unsigned instance, uint32_t baud);
hal_uart_t *hal_uart_open_cfg(const hal_uart_cfg_t *cfg);
size_t hal_uart_read(hal_uart_t *u, uint8_t *buf, size_t maxlen);
size_t hal_uart_write(hal_uart_t *u, const uint8_t *buf, size_t len);

/* ---- TIM + DMA (DShot path) ---- */
typedef struct hal_tim_dma hal_tim_dma_t;

typedef struct {
    unsigned  tim;     /* 1..N; 0 invalid */
    unsigned  channel; /* 1..4; 0 invalid */
    hal_pin_t pin;
    uint32_t  bit_hz;  /* e.g. 600000 for DShot600 */
} hal_tim_dma_cfg_t;

hal_tim_dma_t *hal_tim_dma_open(unsigned tim, unsigned channel);
hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *cfg);
bool hal_tim_dma_start_burst(hal_tim_dma_t *t, const uint16_t *words, size_t n);
/** Re-time the DShot bit clock (300000 or 600000 Hz); false if invalid. */
bool hal_tim_dma_set_bit_rate(uint32_t hz);

/* ---- EXTI ---- */
typedef void (*hal_exti_cb_t)(void *ctx);
bool hal_exti_attach(hal_pin_t pin, hal_exti_cb_t cb, void *ctx);

/* ---- USB CDC ---- */
bool   hal_usb_cdc_init(void);
void   hal_usb_cdc_poll(void);
size_t hal_usb_cdc_read(uint8_t *buf, size_t maxlen);
size_t hal_usb_cdc_write(const uint8_t *buf, size_t len);
bool   hal_usb_cdc_connected(void);

/* ---- flash (params later) ---- */
bool hal_flash_read(uint32_t offset, void *dst, size_t len);
bool hal_flash_write(uint32_t offset, const void *src, size_t len);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_HAL_H */
