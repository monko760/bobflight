/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Failsafe: on trigger, disarm and clear motor request.
 */
#ifndef BOBFLIGHT_FAILSAFE_H
#define BOBFLIGHT_FAILSAFE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void failsafe_init(void);
void failsafe_tick(uint32_t now_ms);
void failsafe_note_rx_frame(uint32_t now_ms);
bool failsafe_active(void);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_FAILSAFE_H */
