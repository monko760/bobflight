/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_BLACKBOX_INPUTS_H
#define BOBFLIGHT_BLACKBOX_INPUTS_H
/* Gathers the schema 3 Blackbox per-frame inputs from the drivers. Read-only:
 * no filter refresh/recompute, no telemetry poll, no scheduler change. */
#include "flight/blackbox_capture.h"
/* Cheap per-PID-loop context: loop code, capture-fail latch, overruns, fill. */
void bb_inputs_context(bb_capture_ctx_t *ctx);
/* Slow inputs for a sample that will be logged (eRPM, telemetry mask, filters). */
void bb_inputs_fill(bb_capture_extra_t *extra);
#endif
