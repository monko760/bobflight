/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 *
 * Persisted, user-selectable PID loop rate (CLI setting `loop_rate_hz`).
 * Allowed values are exactly 1000, 4000 and 8000; any other value is rejected.
 * Mapping to the scheduler (sched/loop_rate.c):
 *   1000 -> gyro 1000 Hz / pid_denom 1 (MPU6000 DLPF_CFG 3, 1 kHz ODR: the
 *           pre-R3 hardware path, unchanged)
 *   4000 -> gyro 8000 Hz / pid_denom 2 (DLPF_CFG 0, 8 kHz ODR)
 *   8000 -> gyro 8000 Hz / pid_denom 1 (DLPF_CFG 0, 8 kHz ODR)
 * 4000 and 8000 need the 8 kHz gyro path, which only kakute_f7_hdv has; other
 * boards refuse them with a reason. The saved value is applied at boot only
 * (takes effect after save + reboot). Runtime fallbacks never change the
 * setting; they are reported by `loop_rate` and status loop_target_hz. */
#ifndef BOBFLIGHT_LOOP_RATE_SETTING_H
#define BOBFLIGHT_LOOP_RATE_SETTING_H
#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define LOOP_RATE_SETTING_1K 1000u
#define LOOP_RATE_SETTING_4K 4000u
#define LOOP_RATE_SETTING_8K 8000u

/* 4000 on kakute_f7_hdv (budget in docs/LOOP-RATE.md), 1000 elsewhere. */
uint32_t loop_rate_setting_default_hz(void);
/* Exactly 1000 | 4000 | 8000. */
bool loop_rate_setting_allowed(uint32_t hz);
/* NULL when this board can run `hz`, else a static reason token. */
const char *loop_rate_setting_unsupported_reason(uint32_t hz);
/* Exact decimal token "1000" | "4000" | "8000" (no sign, spaces, exponent or fraction). */
bool loop_rate_setting_parse(const char *text, uint32_t *out);
/* Allowed and supported on this board; otherwise unchanged and false. */
bool loop_rate_setting_set(uint32_t hz);
uint32_t loop_rate_setting_get(void);
void loop_rate_setting_defaults(void);
/* True when the setting needs the 8 kHz MPU6000 output rate (4000 / 8000). */
bool loop_rate_setting_wants_8k_gyro(uint32_t hz);

#ifdef __cplusplus
}
#endif
#endif /* BOBFLIGHT_LOOP_RATE_SETTING_H */
