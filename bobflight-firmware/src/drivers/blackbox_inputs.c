/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "drivers/blackbox_inputs.h"
#include "drivers/dshot_telem.h"
#include "drivers/gyro.h"
#include "drivers/rpm_filter_gyro.h"
#include "sched/scheduler.h"
#include <string.h>
_Static_assert(DSHOT_TELEM_MOTOR_COUNT == 4u, "Blackbox logs four eRPM fields");
_Static_assert(RPM_FILTER_OFF == 0 && RPM_FILTER_BIDIR_OFF == 1 && RPM_FILTER_ERPM_UNAVAILABLE == 2 &&
               RPM_FILTER_OK == 3, "bobflightFilterFlags rpm reason codes are frozen (docs/BLACKBOX-FIELDS.md)");
void bb_inputs_fill(bb_capture_extra_t *x)
{
    if (!x) return;
    memset(x, 0, sizeof *x);
    for (unsigned m = 0; m < DSHOT_TELEM_MOTOR_COUNT; m++) {
        if (dshot_telem_status(m) != DSHOT_TELEM_OK) continue;
        x->telem_ok |= (uint8_t)(1u << m);
        x->erpm[m] = dshot_erpm(m);
    }
    rpm_filter_status_t rpm;
    rpm_filter_gyro_snapshot(&rpm);
    x->filter_flags = bb_filter_flags_pack(gyro_notch_active_snapshot(1u), gyro_notch_active_snapshot(2u),
                                           (unsigned)rpm.reason, rpm.harmonics_active);
}
void bb_inputs_context(bb_capture_ctx_t *ctx)
{
    if (!ctx) return;
    const scheduler_stats_t *st = scheduler_stats();
    ctx->loop_code = bb_loop_code(scheduler_loop_target_hz());
    ctx->telem_capture_failed = dshot_telem_capture_failed();
    ctx->overruns_total = st ? (uint32_t)st->overruns : 0u;
    ctx->fill = bb_inputs_fill;
}
