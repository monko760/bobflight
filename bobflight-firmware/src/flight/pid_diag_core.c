/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Compile the original equation in a separate translation unit/state namespace.
 * Production pid.c is unchanged. Its static dt, integral and derivative history
 * are distinct here; numerical equivalence is tested against production PID.
 */
#define pid_init pid_diag_core_reset
#define pid_set_dt pid_diag_core_dt
#define pid_update pid_diag_core_update
#include "pid.c"
