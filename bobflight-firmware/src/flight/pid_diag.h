/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 *
 * ACRO/RATE zero-output shadow PID diagnostic interface.
 */
#ifndef BOBFLIGHT_PID_DIAG_H
#define BOBFLIGHT_PID_DIAG_H

#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    PID_DIAG_SOURCE_ZERO = 0,
    PID_DIAG_SOURCE_RX = 1
} pid_diag_source_t;

typedef struct {
    uint32_t version;
    bool active;
    bool valid;
    const char *reason;
    pid_diag_source_t source;
    uint32_t sample_seq;
    int64_t sample_age_us;
    uint32_t dt_us;
    float setpoint_dps[3];
    float gyro_dps[3];
    float error_dps[3];
    float correction[3];
    uint32_t reset_count;
    uint32_t session_age_ms;
} pid_diag_snapshot_t;

void pid_diag_init(void);
void pid_diag_update(uint64_t now_us, const float gyro_dps[3]);
bool pid_diag_start(pid_diag_source_t source, const char **err_msg);
void pid_diag_stop(const char *reason);
void pid_diag_get_snapshot(pid_diag_snapshot_t *out);
bool pid_diag_is_active(void);

/**
 * Main CLI process entry point for pid_diag commands.
 */
void pid_diag_cli_process(const char *cmd_line, char *out_buf, size_t max_len);

#ifdef __cplusplus
}
#endif

#endif /* BOBFLIGHT_PID_DIAG_H */
