/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef BOBFLIGHT_RX_INTERNAL_H
#define BOBFLIGHT_RX_INTERNAL_H

#include <stdbool.h>

void rx_stub_set_channels(const float *ch, unsigned n, bool fresh);
bool crsf_uart_bound(void);

#endif
