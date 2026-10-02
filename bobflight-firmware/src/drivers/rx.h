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

/*
 * CRSF LINK_STATISTICS (frame type 0x14) link gate. No setting.
 * Until the first valid stats frame since rx_init() (boot, receiver_map or
 * receiver_uart change) the gate is open: loss detection is frames-only.
 * Once stats have been seen, an uplink LQ of 0, an rf_profile of 0 (CRSF
 * 4 fps mode) in the latest FRESH stats frame, or no stats frame for more
 * than RX_LINK_STATS_STALE_MS, closes the gate: valid RC frames are then NOT
 * accepted (channels, frame count and the failsafe loss timer are left
 * untouched), so the existing 250 ms failsafe timeout runs exactly as if the
 * frames had stopped. A link that drops to 4 fps mid-flight therefore goes
 * into failsafe instead of flying on. A fresh stats frame with LQ > 0 and
 * rf_profile != 0 reopens the gate; the next accepted RC frame then clears
 * failsafe under the existing rules (stats alone clear nothing; no automatic
 * re-arm: arming needs a new edge).
 * Reason priority: no-frames > lq-zero > rf-mode-low > stats-stale. Stale
 * stats carry no current LQ or rf_profile, so a stale link always reports
 * stats-stale (also when its last frame had LQ 0 or rf_profile 0).
 */
#define RX_LINK_STATS_STALE_MS 1000u
typedef enum {
    RX_LOSS_NONE = 0,
    RX_LOSS_NO_FRAMES,   /* no valid RC frame (accepted or gated) for >250 ms, or never */
    RX_LOSS_LQ_ZERO,     /* stats seen, latest uplink LQ is 0 */
    RX_LOSS_STATS_STALE, /* stats seen, none for >RX_LINK_STATS_STALE_MS */
    RX_LOSS_RF_MODE_LOW  /* fresh stats, LQ > 0, latest rf_profile 0 (4 fps): "rf-mode-low" */
} rx_loss_reason_t;
/** True once a valid LINK_STATISTICS frame arrived since rx_init(). */
bool rx_link_stats_present(void);
/** Latest uplink LQ 0..100 while stats are present and not stale; -1 otherwise. */
int rx_link_lq(void);
rx_loss_reason_t rx_loss_reason(void);
const char *rx_loss_reason_name(rx_loss_reason_t reason);

extern const rx_protocol_t rx_crsf;

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_RX_H */
