/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * RX protocol vtable. CRSF first (stub); SBUS later.
 */
#ifndef BOBFLIGHT_RX_H
#define BOBFLIGHT_RX_H

#include <stdint.h>
#include <stdbool.h>
#include <stdint.h>
uint32_t rx_frame_count(void);

#ifdef __cplusplus
extern "C" {
#endif

#define RX_CHANNEL_COUNT 16

typedef struct {
    const char *name;
    bool (*init)(void);
    void (*poll)(void);
} rx_protocol_t;

void rx_init(void);
void rx_poll(void);
/** Channels normalized roughly [-1,1] for sticks; mid = 0. Stub: zeros. */
const float *rx_channels(void);
bool rx_frame_fresh(void);
/* UINT32_MAX means no accepted frame since receiver initialization. */
uint32_t rx_frame_age_ms(void);
bool rx_uart_bound(void);
const char *rx_protocol_name(void);

extern const rx_protocol_t rx_crsf;

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_RX_H */
