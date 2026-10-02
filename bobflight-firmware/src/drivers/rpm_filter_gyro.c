/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0
 * RPM notch filter runtime (see drivers/rpm_filter_gyro.h, docs/RPM-FILTER.md).
 * Runs in task context from gyro_filter(): the eRPM it reads was decoded by
 * dshot_telem_poll_all() in the previous cycle's dshot_write (one frame late,
 * never blocking, no ISR access). The CLI also refreshes the state; the
 * cooperative scheduler never lets the two preempt each other. */
#include "drivers/rpm_filter_gyro.h"
#include "drivers/dshot_telem.h"
#include "drivers/gyro.h"
#include "flight/config.h"
#include <string.h>
#include <math.h>

_Static_assert(DSHOT_TELEM_MOTOR_COUNT == RPM_FILTER_MOTORS, "RPM filter motor count must match DShot telemetry");

static rpm_filter_bank_t g_rpm;
static bool g_rpm_ready;

static void read_settings(rpm_filter_settings_t *s)
{
    const bf_config_t *c = config_get();
    s->harmonics = c ? (unsigned)c->rpm_filter_harmonics : 0u;
    s->min_hz = c ? c->rpm_filter_min_hz : RPM_FILTER_DEFAULT_MIN_HZ;
    s->q = (c ? c->rpm_filter_q_x100 : RPM_FILTER_DEFAULT_Q_X100) / 100.f;
    s->poles = c ? (unsigned)c->motor_poles : (unsigned)RPM_FILTER_DEFAULT_POLES;
}

static void read_input(rpm_filter_input_t *in)
{
    memset(in, 0, sizeof *in);
    in->bidir = dshot_bidir_enabled();
    for (unsigned m = 0; m < RPM_FILTER_MOTORS; m++) {
        const uint32_t e = dshot_erpm(m);
        in->erpm[m] = e;
        in->valid[m] = in->bidir && dshot_telem_status(m) == DSHOT_TELEM_OK && e > 0u;
    }
}

static void refresh(float dt)
{
    if (!g_rpm_ready) { rpm_filter_init(&g_rpm); g_rpm_ready = true; }
    rpm_filter_settings_t s;
    rpm_filter_input_t in;
    read_settings(&s);
    read_input(&in);
    rpm_filter_update(&g_rpm, &s, &in, dt);
}

void rpm_filter_gyro_process(float v[3], float dt)
{
    if (!v) return;
    refresh(dt);
    rpm_filter_apply(&g_rpm, v);
}

static void report(rpm_filter_status_t *st)
{
    memset(st, 0, sizeof *st);
    if (!g_rpm_ready) { st->reason = RPM_FILTER_OFF; return; }
    st->reason = g_rpm.reason;
    st->harmonics = g_rpm.set.harmonics;
    st->harmonics_active = g_rpm.harmonics_active;
    for (unsigned m = 0; m < RPM_FILTER_MOTORS; m++) {
        st->motor_valid[m] = g_rpm.reason == RPM_FILTER_OK && g_rpm.motor_valid[m];
        st->motor_hz[m] = st->motor_valid[m] ? g_rpm.fund_hz[m] : 0.f;
    }
}

void rpm_filter_gyro_status(rpm_filter_status_t *st, float dt)
{
    refresh(dt);
    if (!st) return;
    report(st);
}

void rpm_filter_gyro_snapshot(rpm_filter_status_t *st)
{
    if (st) report(st);
}

void rpm_filter_gyro_install(void)
{
    rpm_filter_init(&g_rpm);
    g_rpm_ready = true;
    gyro_set_post_filter(rpm_filter_gyro_process);
}
