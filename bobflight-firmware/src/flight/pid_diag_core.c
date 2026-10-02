/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Compile the original equation in a separate translation unit/state namespace.
 * Production pid.c is unchanged. Its static dt, integral and derivative history
 * are distinct here; numerical equivalence is tested against production PID.
 */
#define pid_init pid_diag_core_reset
#define pid_set_dt pid_diag_core_dt
#define pid_update pid_diag_core_update
#define pid_trace_enable pid_diag_core_trace_enable
#define pid_trace_read pid_diag_core_trace_read
/* Safety S1 hooks get their own names too; the diagnostic core never sets
 * them, so it keeps the original first-order D-term and no mixer freeze. */
#define pid_set_mixer_saturated pid_diag_core_set_mixer_saturated
#define pid_set_dterm_lpf_pt2 pid_diag_core_set_dterm_lpf_pt2
#define pid_dterm_lpf_pt2 pid_diag_core_dterm_lpf_pt2
#include "pid.c"
