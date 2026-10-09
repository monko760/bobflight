/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_F405_GYRO_SPI_BRIDGE_H
#define BOBFLIGHT_F405_GYRO_SPI_BRIDGE_H
#include "spi_component.h"
#include "hal/hal.h"
/* Isolated F405 bridge to the EXISTING shared MPU driver, not a registered
 * main-firmware target. Caller owns GPIO/AF/CS initialization and SPI1, initializes
 * transport first, then binds before gyro_init(). Must have a CS callback.
 * Single-thread, exclusive ownership; do not bind/unbind while a call is active.
 * No fast sensor clocks in this initial port: both reads/writes stay <=1 MHz.
 * Does not configure EXTI, motors, arming, persistence, or board qualification. */
bool bf_f405_gyro_spi_bind(bf_f405_spi_bus_t *transport, hal_pin_t cs);
void bf_f405_gyro_spi_unbind(void);
#endif
