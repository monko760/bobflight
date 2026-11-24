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
 * Once stats have been seen, the gate closes when the latest FRESH stats frame
 * reports an uplink LQ of 0, when no stats frame arrived for more than
 * RX_LINK_STATS_STALE_MS, or when the RC frames themselves arrive too slowly
 * (the last RX_LINK_RATE_FRAMES valid frames span more than RX_LINK_RATE_SPAN_MS,
 * i.e. a ~4 Hz link such as TBS Crossfire 4 fps; unknown until that many
 * frames have arrived since rx_init(), and unknown counts as slow). While the
 * gate is closed valid RC frames are NOT accepted (channels, frame count and
 * the failsafe loss timer are left untouched), so the existing 250 ms failsafe
 * timeout runs exactly as if the frames had stopped.
 * The CRSF rf_mode byte is reported (receiver report, blackbox) but never
 * closes the gate: it is a vendor-specific index, not a rate. TBS Crossfire
 * uses 0 for 4 fps, while ExpressLRS 4.x uses 0 for its valid 900 MHz 25 Hz
 * rate (ExpressLRS 3.x reports 25 Hz as 1). Treating rf_mode 0 as loss would
 * failsafe a healthy 25 Hz ELRS link.
 * A fresh stats frame with LQ > 0 and a normal frame rate reopen the gate; the
 * next accepted RC frame then clears failsafe under the existing rules (stats
 * alone clear nothing; no automatic re-arm: arming needs a new edge).
 * Reason priority: no-frames > stats-stale > lq-zero > link-rate-low. Stale
 * stats carry no current LQ, so a stale link always reports stats-stale (also
 * when its last frame had LQ 0).
 */
#define RX_LINK_STATS_STALE_MS 1000u
/* ~4 Hz link policy (Oct 2 decision): the last 8 valid RC frames spanning
 * more than 1000 ms (under ~8 frames per second) is a slow link and counts as
 * loss. 8 frames take 280 ms at 25 Hz (560 ms at 25 Hz with every other packet
 * lost) and 1750 ms at 4 Hz. */
#define RX_LINK_RATE_FRAMES 8u
#define RX_LINK_RATE_SPAN_MS 1000u
typedef enum {
    RX_LOSS_NONE = 0,
    RX_LOSS_NO_FRAMES,    /* no valid RC frame (accepted or gated) for >250 ms, or never */
    RX_LOSS_LQ_ZERO,      /* stats seen, latest uplink LQ is 0 */
    RX_LOSS_STATS_STALE,  /* stats seen, none for >RX_LINK_STATS_STALE_MS */
    RX_LOSS_LINK_RATE_LOW /* fresh stats, LQ > 0, RC frames too slow (~4 Hz): "link-rate-low" */
} rx_loss_reason_t;

typedef struct {
    int16_t rssi1_dbm;      /** Uplink RSSI 1 (dBm, e.g. -60) */
    int16_t rssi2_dbm;      /** Uplink RSSI 2 (dBm, e.g. -62) */
    uint8_t uplink_lq;      /** Uplink Link Quality (0..100 %) */
    int8_t  uplink_snr;     /** Uplink SNR (dB) */
    uint8_t active_antenna; /** Active/selected antenna index (0 or 1) */
    uint8_t rf_mode;        /** RF mode / profile */
    bool    valid;          /** True if at least one valid LINK_STATISTICS frame was received since rx_init() */
    bool    fresh;          /** True if valid AND last frame was received within RX_LINK_STATS_STALE_MS */
    uint32_t age_ms;        /** Age of last LINK_STATISTICS frame in ms (UINT32_MAX if !valid) */
} rx_link_stats_snapshot_t;

/** True once a valid LINK_STATISTICS frame arrived since rx_init(). */
bool rx_link_stats_present(void);
/** Latest uplink LQ 0..100 while stats are present and not stale; -1 otherwise. */
int rx_link_lq(void);
rx_loss_reason_t rx_loss_reason(void);
const char *rx_loss_reason_name(rx_loss_reason_t reason);

/**
 * Read-only snapshot of the latest CRSF link statistics.
 * Returns true if valid and fresh (received within RX_LINK_STATS_STALE_MS), false otherwise.
 * Link-stat freshness depends exclusively on link-stat frame receipt time, not RC frames.
 * When stats have never been received (!valid), fields contain no fabricated zeros for stat frame data.
 */
bool rx_link_stats_snapshot(rx_link_stats_snapshot_t *out);

extern const rx_protocol_t rx_crsf;

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_RX_H */
