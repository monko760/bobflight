/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_SD_SPI_HW_H
#define BOBFLIGHT_SD_SPI_HW_H
#include "drivers/sd_spi.h"
/* Disarmed preparation only. No target pins are configured on unsupported
 * boards. This does not initialize a card or enable recording. */
bool sd_spi_hw_bind(sd_spi_io_t *io);
void sd_spi_hw_cancel(void);
#endif
