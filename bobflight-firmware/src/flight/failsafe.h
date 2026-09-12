/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * Staged failsafe.
 *
 * Stage HOLD    : no RX frames for FAILSAFE_RX_TIMEOUT_MS. The craft is
 *                 commanded level attitude while throttle holds its last
 *                 value. A fresh frame inside the hold window recovers
 *                 instantly with no disarm.
 * Stage PROCEDURE: hold window elapsed. The configured action runs:
 *                 DROP (disarm now), HOLD (stay level until RX returns),
 *                 or LAND (level + descent throttle, disarm on timeout).
 *
 * Until the first RX frame ever arrives the module reports active, which
 * blocks arming at boot. Defaults preserve the verified baseline: DROP
 * with a zero-length hold window disarms as soon as the link is stale.
 */
#ifndef BOBFLIGHT_FAILSAFE_H
#define BOBFLIGHT_FAILSAFE_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    FAILSAFE_ACTION_DROP = 0, /* disarm as soon as the hold window is out */
    FAILSAFE_ACTION_HOLD,    /* level + held throttle until RX returns */
    FAILSAFE_ACTION_LAND      /* level + descent throttle, disarm on timer */
} failsafe_action_t;

typedef enum {
    FAILSAFE_STAGE_IDLE = 0, /* link healthy */
    FAILSAFE_STAGE_HOLD,     /* link stale, inside the recovery window */
    FAILSAFE_STAGE_PROCEDURE /* recovery window out, action running */
} failsafe_stage_t;

void failsafe_init(void);
/* Invalidate the old RX link after a disarmed UART/mapping change; retain policy. */
void failsafe_reset_rx_link(void);
void failsafe_tick(uint32_t now_ms);
void failsafe_note_rx_frame(uint32_t now_ms);
bool failsafe_active(void);
failsafe_stage_t failsafe_stage(void);

/* Configuration. Set before arming; not intended to change mid-flight. */
void failsafe_set_action(failsafe_action_t action);
void failsafe_set_hold_ms(uint32_t ms);
void failsafe_set_land_ms(uint32_t ms);
void failsafe_set_land_throttle(float throttle_01);

/*
 * If true, the caller should fly these instead of pilot sticks:
 * sticks[0..2] are roll/pitch/yaw setpoints (0 = level), sticks[3] is
 * throttle in [0,1]. Returns false while the link is healthy.
 */
bool failsafe_command_override(float sticks[4]);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_FAILSAFE_H */
