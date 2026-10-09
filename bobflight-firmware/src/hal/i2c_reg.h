/* SPDX-License-Identifier: Apache-2.0
 * STM32F722 I2C1 register read/write bus interface.
 */
#ifndef BOBFLIGHT_HAL_I2C_REG_H
#define BOBFLIGHT_HAL_I2C_REG_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include "hal/hal.h"

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Bind I2C register bus driver to hardware instance.
 * Validates board_mmio_permitted(), MCU STM32F722, highres time, and
 * bus 1 exact routing (PB8 SCL, PB9 SDA).
 */
bool i2c_reg_bind(unsigned bus, hal_pin_t scl, hal_pin_t sda);

/**
 * Begin nonblocking register transaction.
 * Refuses without stealing bus if bus is BUSY or driver is already active.
 * Buffers are borrowed until completion.
 */
bool i2c_reg_begin(uint8_t addr, uint8_t reg, uint8_t *data, uint8_t len, bool read, uint64_t now);

/**
 * Poll ongoing nonblocking transaction.
 * At most 1 byte / state step per call.
 * Returns: -1 on error/timeout, 0 if pending, 1 if done.
 */
int i2c_reg_poll(uint64_t now);

/**
 * Cancel active owned transaction.
 * Releases own transaction but does not steal/touch an unowned busy bus.
 */
void i2c_reg_cancel(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_HAL_I2C_REG_H */
