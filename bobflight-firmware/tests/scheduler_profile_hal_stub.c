/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * Native task fixtures supply a deterministic microsecond clock. Profiling
 * stays OFF in these fixtures; the dedicated profile test owns a mutable
 * clock-health stub for refusal/failure coverage. Never linked into firmware. */
#include "hal/hal.h"
bool hal_time_high_resolution(void){return true;}
