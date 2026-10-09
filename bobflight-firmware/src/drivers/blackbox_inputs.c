/* Copyright 2026 Robert Leclercq. SPDX-License-Identifier: Apache-2.0 */
#include "drivers/blackbox_inputs.h"
#include "drivers/dshot_telem.h"
#include "drivers/gyro.h"
#include "drivers/rpm_filter_gyro.h"
#include "sched/scheduler.h"
#include <string.h>
#include <math.h>
#include "flight/attitude.h"
#include "drivers/rx.h"
#include "drivers/barometer.h"
_Static_assert(DSHOT_TELEM_MOTOR_COUNT == 4u, "Blackbox logs four eRPM fields");
_Static_assert(RPM_FILTER_OFF == 0 && RPM_FILTER_BIDIR_OFF == 1 && RPM_FILTER_ERPM_UNAVAILABLE == 2 &&
               RPM_FILTER_OK == 3, "bobflightFilterFlags rpm reason codes are frozen (docs/BLACKBOX-FIELDS.md)");
void bb_inputs_fill(bb_capture_extra_t *x)
{
    if (!x) return;
    memset(x, 0, sizeof *x);
    bmp280_snapshot_t baro;barometer_read_snapshot(&baro);
    x->baro_pressure_pa=baro.pressure;x->baro_temp_c=baro.temp;x->baro_alt_cm=baro.relativealt;x->baro_reference_pa=baro.reference;
    x->baro_valid=baro.valid;x->baro_alt_valid=baro.alt_valid;x->baro_age_ms=baro.age_ms;x->baro_sample=baro.sample_seq;
    rx_link_stats_snapshot_t link={0};
    x->link_valid=rx_link_stats_snapshot(&link);x->link_age_ms=link.age_ms;
    if(x->link_valid){x->rssi_dbm[0]=link.rssi1_dbm;x->rssi_dbm[1]=link.rssi2_dbm;x->link_lq=link.uplink_lq;x->link_snr=link.uplink_snr;x->link_antenna=link.active_antenna;x->link_rf_mode=link.rf_mode;}
    const float *a=gyro_accel_g(),*d=attitude_degrees();
    x->accel_valid=gyro_is_healthy()&&a;
    x->attitude_valid=gyro_is_healthy()&&attitude_ready()&&d;
    for(unsigned n=0;n<3;n++){
        if(a){x->accel_g[n]=a[n];x->accel_valid=x->accel_valid&&isfinite(a[n]);}
        if(d){x->attitude_deg[n]=d[n];x->attitude_valid=x->attitude_valid&&isfinite(d[n]);}
    }
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
    ctx->mixer_throttle=0.f;ctx->mixer_throttle_valid=false;
    const scheduler_stats_t *st = scheduler_stats();
    ctx->loop_code = bb_loop_code(scheduler_loop_target_hz());
    ctx->telem_capture_failed = dshot_telem_capture_failed();
    ctx->overruns_total = st ? (uint32_t)st->overruns : 0u;
    ctx->fill = bb_inputs_fill;
}
