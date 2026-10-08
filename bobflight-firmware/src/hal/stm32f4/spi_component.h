/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_F405_SPI_COMPONENT_H
#define BOBFLIGHT_F405_SPI_COMPONENT_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "clock_plan.h"
#if !defined(__arm__) || !defined(__thumb__) || !defined(BF_F4_COMPONENT_F405XG)
#error "SPI component requires exact F405xG ARM Thumb compilation"
#endif
#if defined(BF_F4_COMPONENT_F411XE)
#error "F411 is not supported by this component"
#endif
typedef struct { volatile uint32_t CR1,CR2,SR,DR,CRCPR,RXCRCR,TXCRCR,I2SCFGR,I2SPR; } bf_f405_spi_regs_t;
typedef enum { BF_F405_SPI_PRESCALER_128=6, BF_F405_SPI_PRESCALER_256=7 } bf_f405_spi_prescaler_t;
typedef enum {
 BF_F405_SPI_OK=0, BF_F405_SPI_ERR_INVALID=1, BF_F405_SPI_ERR_CONTEXT=2,
 BF_F405_SPI_ERR_CLOCK=3, BF_F405_SPI_ERR_STUCK_TXE=4, BF_F405_SPI_ERR_STUCK_RXNE=5,
 BF_F405_SPI_ERR_STUCK_BSY=6, BF_F405_SPI_ERR_OVERRUN=7, BF_F405_SPI_ERR_UNBOUND=8,
 BF_F405_SPI_ERR_ALREADY=9, BF_F405_SPI_ERR_TIME=10, BF_F405_SPI_ERR_HARDWARE=11
} bf_f405_spi_status_t;
typedef void (*bf_f405_spi_cs_fn_t)(void *ctx,bool assert_cs);
typedef struct {
 bf_f405_spi_regs_t *regs;
 bf_f405_spi_prescaler_t prescaler;
 uint32_t poll_budget,timeout_us;
 bf_f405_spi_cs_fn_t cs_fn; void *cs_ctx;
 bool initialized,in_error,busy;
 bf_f405_spi_status_t last_error;
 uint32_t last_polls,last_elapsed_us;
} bf_f405_spi_bus_t;
#define BF_F405_SPI1_BASE ((bf_f405_spi_regs_t *)0x40013000u)
#define BF_F405_SPI_MAX_TRANSFER 64u
/* Zero-initialize bus. Cold-reset, Thread mode, PRIMASK=1, established 168/84 MHz
 * HCLK/APB2, initialized healthy timebase and exclusive SPI1 ownership required.
 * Caller owns GPIO/AF and keeps CS inactive. regs is NULL or SPI1's exact base.
 * SPI1 only, mode 3, 8 bits, <=1MHz; never writes F7-specific CR2.DS/FRXTH.
 * An attempted hardware initialization is one-shot. A hardware fault is latched
 * until the device is reset; no automatic or partial peripheral recovery.
 * No MCU/pin routing qualification is implied by the compile-time guard. */
bf_f405_spi_status_t bf_f405_spi_init(bf_f405_spi_bus_t *,bf_f405_spi_regs_t *,const bf_f4_clock_plan_t *,bf_f405_spi_prescaler_t);
/* Thread-only runtime calls permit interrupts and never change PRIMASK. No
 * concurrent callers. CS callback must return promptly and must not reenter.
 * Deadline and poll count cover the WHOLE transaction, not each byte. A frozen
 * or faulty clock cannot defeat the independent finite poll limit. Preemption
 * may extend wall-clock latency; no hard interrupt-latency guarantee is made.
 * On failure RX contents are partial/invalid, SPE disable and CS release are
 * requested and error latched. Callback completion is not GPIO readback proof. */
bf_f405_spi_status_t bf_f405_spi_transfer(bf_f405_spi_bus_t *,const uint8_t *,uint8_t *,size_t);
bf_f405_spi_status_t bf_f405_spi_set_prescaler(bf_f405_spi_bus_t *,bf_f405_spi_prescaler_t);
bf_f405_spi_status_t bf_f405_spi_set_timeouts(bf_f405_spi_bus_t *,uint32_t,uint32_t);
bf_f405_spi_status_t bf_f405_spi_set_cs_callback(bf_f405_spi_bus_t *,bf_f405_spi_cs_fn_t,void *);
bool bf_f405_spi_is_ready(const bf_f405_spi_bus_t *);
#endif
