/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 *
 * Loop-rate policy: which gyro task rate / PID divider the scheduler runs.
 * The requested rate is the persisted `loop_rate_hz` setting as it was at
 * boot (sched/loop_rate_setting.h): 1000 -> 1000/1, 4000 -> 8000/2,
 * 8000 -> 8000/1. With bidirectional DShot on (B2, non-blocking DMA
 * capture) 4000 runs as set; 8000 is capped to 8000/2 (reason
 * dshot-bidir-reply-window: the reply cannot fit 125 us with margin), and a
 * latched capture failure forces 1000/1 (dshot-bidir-capture-failed).
 * 4000/8000 run only on kakute_f7_hdv (MPU6000 on SPI4 at 8 kHz ODR) and
 * only while the timebase, gyro, DShot mode and measured cascade budget
 * support it. Every fallback is reported by the `loop_rate`
 * CLI command and visible in `status` loop_target_hz (the rate actually
 * applied). Never raises the rate while armed; overrun-guard drops apply
 * immediately and step down one ladder level at a time.
 */
#ifndef BOBFLIGHT_LOOP_RATE_H
#define BOBFLIGHT_LOOP_RATE_H
#include <stdbool.h>
#include <stdint.h>
#include <string.h>
#include "board/board.h"

#ifdef __cplusplus
extern "C" {
#endif

/* 8 kHz gyro task: / 2 = 4 kHz PID (setting 4000), / 1 = 8 kHz PID (setting 8000). */
#define LOOP_RATE_FAST_GYRO_HZ 8000u
#define LOOP_RATE_FAST_PID_DENOM 2u
#define LOOP_RATE_8K_PID_DENOM 1u
/* Overrun-guard step: 4 kHz gyro task (250 us slot) / 2 = 2 kHz PID. */
#define LOOP_RATE_REDUCED_GYRO_HZ 4000u
#define LOOP_RATE_REDUCED_PID_DENOM 2u
/* Pre-R3 rate every other board keeps (and the last fallback). */
#define LOOP_RATE_LEGACY_GYRO_HZ 1000u
#define LOOP_RATE_LEGACY_PID_DENOM 1u
/* MPU6000 sample read = 2-byte INT_STATUS + 15-byte burst = 136 SPI bits.
 * At >= 10 MHz that is <= 13.6 us of the 125 us gyro slot. */
#define LOOP_RATE_MIN_GYRO_SPI_HZ 10000000u
/* Guard: a closed ~1 s window whose overruns exceed 1% of its gyro slots is
 * a breach; two consecutive breaches step the rate down one ladder level:
 *   setting 8000: 8000/1 -> 8000/2 -> 4000/2 -> 1000/1
 *   setting 4000: 8000/2 -> 4000/2 -> 1000/1 */
#define LOOP_RATE_GUARD_PERMILLE 10u
#define LOOP_RATE_GUARD_BREACHES 2u
#define LOOP_RATE_LADDER_MAX 4u

/* Only the Kakute F7 HDV target has the 8 kHz gyro path (board IR:
 * MPU6000, SPI4). Header-only so the gyro driver can share the decision. */
static inline bool loop_rate_board_fast(const board_t *b)
{
    return b && strcmp(b->board_id, "kakute_f7_hdv") == 0;
}

typedef struct { uint32_t gyro_hz, pid_denom; } loop_rate_t;

typedef struct {
    uint32_t requested_hz; /* loop_rate_hz setting applied at boot: 1000|4000|8000 */
    bool board_fast;      /* loop_rate_board_fast(board_get()) */
    bool high_res_time;   /* hal_time_high_resolution(): DWT us, not ms tick */
    bool dshot_bidir;     /* bidir DShot on: ladder capped to proven reply windows */
    unsigned dshot_kbps;  /* 300 | 600: sets the bidir reply window */
    bool dshot_capture_failed; /* dshot_telem_capture_failed(): forces 1000/1 */
    bool gyro_healthy;
    uint32_t gyro_odr_hz; /* configured sensor output rate, 0 = unknown */
    uint32_t gyro_spi_hz; /* sensor-read SPI clock, 0 = not raised */
    unsigned guard_level; /* ladder index: 0 = requested rate */
} loop_rate_inputs_t;

/* Pure decision; *reason is a static token (never NULL). */
loop_rate_t loop_rate_select(const loop_rate_inputs_t *in, const char **reason);
/* True when a closed window's overruns exceed LOOP_RATE_GUARD_PERMILLE. */
bool loop_rate_window_breach(uint32_t overruns, uint32_t gyro_slots);
/* Guard ladder for a requested setting; returns its length (>= 1). */
unsigned loop_rate_ladder(uint32_t requested_hz, loop_rate_t out[LOOP_RATE_LADDER_MAX]);
/* Same ladder with bidir on: drops every rate whose worst-case reply window
 * is not proven (dshot_bidir_window_fits); 1000/1 always stays. *capped (may
 * be NULL) is set when an entry was dropped (today: 8000/1 at DShot300/600). */
unsigned loop_rate_ladder_bidir(uint32_t requested_hz, bool dshot_bidir, unsigned dshot_kbps,
                                loop_rate_t out[LOOP_RATE_LADDER_MAX], bool *capped);

void loop_rate_init(void);   /* after persist_load + gyro rate select: scheduler_init */
void loop_rate_tick(void);   /* main loop, outside the cascade */
loop_rate_t loop_rate_requested_profile(void); /* ladder[0] of the boot setting */
uint32_t loop_rate_boot_setting_hz(void);      /* loop_rate_hz applied at boot */
bool loop_rate_pending_reboot(void);           /* setting changed since boot */
loop_rate_t loop_rate_active(void);
const char *loop_rate_reason(void);
unsigned loop_rate_guard_level(void);

#ifdef __cplusplus
}
#endif
#endif /* BOBFLIGHT_LOOP_RATE_H */
