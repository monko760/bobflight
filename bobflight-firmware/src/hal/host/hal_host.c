#if !defined(_WIN32) && !defined(_POSIX_C_SOURCE)
#define _POSIX_C_SOURCE 200809L
#endif
/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Host (gcc) HAL stubs for smoke builds — no MCU hardware.
 */
#include "hal/hal.h"
void hal_power_adc_init(hal_pin_t voltage, hal_pin_t current) { (void)voltage; (void)current; }
bool hal_power_adc_poll(uint16_t *voltage, uint16_t *current) { (void)voltage; (void)current; return false; }

#include <stdio.h>
#include <string.h>
#include <time.h>
#include <errno.h>

#if defined(_WIN32)
#include <windows.h>
#include <io.h>
#include <fcntl.h>
#else
#include <sys/time.h>
#include <unistd.h>
#include <fcntl.h>
#endif

static uint64_t g_start_us,g_host_last;
static bool g_host_clock_ok=true;

static uint64_t host_now_us(void)
{
#if defined(_WIN32)
    static LARGE_INTEGER freq, start;
    static int init;
    LARGE_INTEGER now;
    if (!init) {
        if(!QueryPerformanceFrequency(&freq) || freq.QuadPart<=0 || !QueryPerformanceCounter(&start)){g_host_clock_ok=false;return g_host_last;}
        init = 1;
    }
    if(!QueryPerformanceCounter(&now) || now.QuadPart<start.QuadPart){g_host_clock_ok=false;return g_host_last;}
    uint64_t ticks=(uint64_t)(now.QuadPart-start.QuadPart),f=(uint64_t)freq.QuadPart;
    uint64_t result=(ticks/f)*1000000ull+(ticks%f)*1000000ull/f;
#else
    struct timespec ts;
    if(clock_gettime(CLOCK_MONOTONIC,&ts)!=0){g_host_clock_ok=false;return g_host_last;}
    uint64_t result=(uint64_t)ts.tv_sec*1000000ull+(uint64_t)ts.tv_nsec/1000ull;
#endif
    if(result<g_host_last){g_host_clock_ok=false;return g_host_last;}
    g_host_last=result;return result;
}

void hal_clock_init(uint32_t hse_mhz)
{
    (void)hse_mhz;
}

const char *hal_clock_usb_src(void)
{
    return "host";
}

uint32_t hal_core_clock_hz(void){return 0;}
bool hal_time_high_resolution(void){return g_host_clock_ok;}
const char *hal_time_source(void){return "host-monotonic";}
void hal_time_init(void)
{
    g_start_us = host_now_us();
}

uint32_t hal_millis(void)
{
    return (uint32_t)((host_now_us() - g_start_us) / 1000ull);
}

uint64_t hal_micros(void)
{
    return host_now_us() - g_start_us;
}

void hal_delay_ms(uint32_t ms)
{
    uint32_t start = hal_millis();
    while ((hal_millis() - start) < ms) {
        /* spin */
    }
}

bool hal_gpio_configure(hal_pin_t pin, const hal_gpio_cfg_t *cfg)
{
    return cfg && hal_pin_valid(pin);
}

void hal_gpio_init(hal_pin_t pin, hal_gpio_mode_t mode)
{
    hal_gpio_cfg_t cfg;
    cfg.mode = mode;
    cfg.pull = HAL_GPIO_PULL_NONE;
    cfg.speed = HAL_GPIO_SPEED_HIGH;
    cfg.af = 0;
    (void)hal_gpio_configure(pin, &cfg);
}

void hal_gpio_write(hal_pin_t pin, bool high)
{
    (void)pin;
    (void)high;
}

bool hal_gpio_read(hal_pin_t pin)
{
    (void)pin;
    return false;
}

struct hal_spi_bus { unsigned index; };

hal_spi_bus_t *hal_spi_open_cfg(const hal_spi_cfg_t *cfg)
{
    static hal_spi_bus_t buses[4];
    if (!cfg || cfg->bus_index == 0 || cfg->bus_index > 4) {
        return NULL;
    }
    buses[cfg->bus_index - 1].index = cfg->bus_index;
    return &buses[cfg->bus_index - 1];
}

hal_spi_bus_t *hal_spi_open(unsigned bus_index)
{
    hal_spi_cfg_t cfg;
    cfg.bus_index = bus_index;
    cfg.hz = 1000000u;
    cfg.cpol = 0;
    cfg.cpha = 0;
    cfg.bits = 8;
    return hal_spi_open_cfg(&cfg);
}

bool hal_spi_transfer(hal_spi_bus_t *bus, hal_pin_t cs,
                      const uint8_t *tx, uint8_t *rx, size_t len)
{
    (void)bus;
    (void)cs;
    (void)tx;
    if (rx && len) {
        memset(rx, 0, len);
    }
    return bus != NULL && cs != HAL_PIN_INVALID;
}

struct hal_uart { unsigned instance; };

hal_uart_t *hal_uart_open_cfg(const hal_uart_cfg_t *cfg)
{
    static hal_uart_t uarts[8];
    if (!cfg || cfg->instance == 0 || cfg->instance > 8) {
        return NULL;
    }
    if (!hal_pin_valid(cfg->rx) && !hal_pin_valid(cfg->tx)) {
        return NULL;
    }
    uarts[cfg->instance - 1].instance = cfg->instance;
    return &uarts[cfg->instance - 1];
}

hal_uart_t *hal_uart_open(unsigned instance, uint32_t baud)
{
    (void)baud;
    (void)instance;
    return NULL; /* host: require open_cfg with board pins */
}

size_t hal_uart_read(hal_uart_t *u, uint8_t *buf, size_t maxlen)
{
    (void)u;
    (void)buf;
    (void)maxlen;
    return 0;
}

size_t hal_uart_write(hal_uart_t *u, const uint8_t *buf, size_t len)
{
    (void)u;
    (void)buf;
    return len;
}

struct hal_tim_dma { unsigned tim; unsigned ch; };

hal_tim_dma_t *hal_tim_dma_open_cfg(const hal_tim_dma_cfg_t *cfg)
{
    static hal_tim_dma_t slots[8];
    static unsigned n;
    if (!cfg || cfg->tim == 0 || cfg->channel == 0 || cfg->channel > 4 || n >= 8) {
        return NULL;
    }
    if (!hal_pin_valid(cfg->pin)) {
        return NULL;
    }
    slots[n].tim = cfg->tim;
    slots[n].ch = cfg->channel;
    return &slots[n++];
}

hal_tim_dma_t *hal_tim_dma_open(unsigned tim, unsigned channel)
{
    (void)tim;
    (void)channel;
    return NULL; /* require pin via open_cfg */
}

bool hal_tim_dma_start_burst(hal_tim_dma_t *t, const uint16_t *words, size_t n)
{
    (void)t;
    (void)words;
    (void)n;
    return false;
}

bool hal_tim_dma_set_bit_rate(uint32_t hz)
{
    return hz == 300000u || hz == 600000u;
}

bool hal_exti_attach(hal_pin_t pin, hal_exti_cb_t cb, void *ctx)
{
    (void)pin;
    (void)cb;
    (void)ctx;
    return pin != HAL_PIN_INVALID;
}

static int g_stdin_nb;

static void host_stdin_nonblock(void)
{
    if (g_stdin_nb) {
        return;
    }
#if defined(_WIN32)
    /* Host smoke is POSIX; Windows path stays best-effort. */
#else
    int flags = fcntl(STDIN_FILENO, F_GETFL, 0);
    if (flags >= 0) {
        (void)fcntl(STDIN_FILENO, F_SETFL, flags | O_NONBLOCK);
    }
#endif
    g_stdin_nb = 1;
}

bool hal_usb_cdc_init(void)
{
    host_stdin_nonblock();
    return true;
}

void hal_usb_cdc_poll(void)
{
}

size_t hal_usb_cdc_read(uint8_t *buf, size_t maxlen)
{
    if (!buf || maxlen == 0) {
        return 0;
    }
    host_stdin_nonblock();
#if defined(_WIN32)
    /* Read redirected test input without blocking the scheduler on a console. */
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    DWORD available = 0, count = 0;
    if (GetFileType(input) != FILE_TYPE_PIPE ||
        !PeekNamedPipe(input, NULL, 0, NULL, &available, NULL) || !available) return 0;
    if (available > maxlen) available = (DWORD)maxlen;
    return ReadFile(input, buf, available, &count, NULL) ? (size_t)count : 0;
#else
    ssize_t n = read(STDIN_FILENO, buf, maxlen);
    if (n < 0) {
        return 0; /* EAGAIN / EWOULDBLOCK / EINTR */
    }
    return (size_t)n;
#endif
}

size_t hal_usb_cdc_write(const uint8_t *buf, size_t len)
{
    if (buf && len) {
        fwrite(buf, 1, len, stdout);
        fflush(stdout);
    }
    return len;
}

bool hal_usb_cdc_connected(void)
{
    return true;
}

/* Process-local flash model: only for host tests, never labeled hardware durable. */
static uint8_t config_flash[2u*256u*1024u];
static bool config_flash_ready;
static void config_flash_init(void){if(!config_flash_ready){memset(config_flash,255,sizeof(config_flash));config_flash_ready=true;}}
bool hal_flash_supported(void){return true;}
const char *hal_flash_backend(void){return "host_sim";}
bool hal_flash_erase_slot(unsigned slot){if(slot>=2)return false;config_flash_init();memset(config_flash+slot*256u*1024u,255,256u*1024u);return true;}
bool hal_flash_read(uint32_t offset,void *dst,size_t len){if(!dst||offset>sizeof(config_flash)||len>sizeof(config_flash)-offset)return false;config_flash_init();memcpy(dst,config_flash+offset,len);return true;}
bool hal_flash_write(uint32_t offset,const void *src,size_t len){if(!src||offset>sizeof(config_flash)||len>sizeof(config_flash)-offset)return false;config_flash_init();const uint8_t*p=src;for(size_t i=0;i<len;i++)if((config_flash[offset+i]&p[i])!=p[i])return false;for(size_t i=0;i<len;i++)config_flash[offset+i]&=p[i];return true;}
