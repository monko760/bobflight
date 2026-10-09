/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef BOBFLIGHT_RX_INTERNAL_H
#define BOBFLIGHT_RX_INTERNAL_H

#include <stdbool.h>
#include <stdint.h>
#include "drivers/crsf.h"

void rx_stub_set_channels(const float *ch, unsigned n, bool fresh);
bool crsf_uart_bound(void);
/* A valid CRSF LINK_STATISTICS frame with uplink LQ 0..100 and its rf_profile (crsf.c). */
void rx_link_note_stats(uint8_t uplink_lq, uint8_t rf_profile);
void rx_link_note_stats_full(const crsf_link_stats_t *stats);

#endif
