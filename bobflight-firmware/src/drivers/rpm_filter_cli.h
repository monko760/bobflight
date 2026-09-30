/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_RPM_FILTER_CLI_H
#define BOBFLIGHT_RPM_FILTER_CLI_H
#include "drivers/rpm_filter_gyro.h"
#include "flight/rpm_filter.h"
#include <math.h>
/* Private; included by cli.c after drivers/filters_cli.h (uses filters_sync_dt).
 *
 * RPM notch filter settings (schema 9; frozen with the Configurator), whole numbers:
 *   rpm_filter_harmonics 0..3 (0 = off)   rpm_filter_min_hz 50..200
 *   rpm_filter_q_x100 100..1000 (Q*100)   motor_poles even 4..36
 * get/diff/dump/defaults/save follow gyro_lpf_hz (%.6g). `set` replies:
 *   ok rpm_filter_harmonics=<v>
 *   set failed: rpm_filter_harmonics must be 0..3
 *   set failed: rpm_filter_min_hz must be 50..200
 *   set failed: rpm_filter_q_x100 must be 100..1000
 *   set failed: motor_poles must be even, 4..36
 *   set failed          (not a number, or not a whole number)
 *   set failed: armed   (every key, before this point in cmd_set)
 * rpm_filter_harmonics > 0 is accepted while dshot_bidir is off; it never
 * enables bidir (the report says bidir-off). motor_poles applies at the next
 * filter update (no reboot).
 *
 * Read-only `rpm_filter` report (framed; frozen: exactly these lines, in this order):
 *   rpm_filter_api: 1
 *   rpm_filter_active: yes|no                      (yes iff reason ok)
 *   rpm_filter_reason: off|ok|bidir-off|erpm-unavailable
 *   rpm_filter_sample_hz: <actual gyro-filter rate, integer Hz>
 *   rpm_filter_harmonics_active: <0..3: setting trimmed to the loop rate, 0 unless ok>
 *   rpm_filter_m1_hz: <tracked fundamental, integer Hz>|unavailable   (m1..m4)
 *   rpm_filter_end: 1
 * The harmonics setting itself is read with `get rpm_filter_harmonics`.
 */

/* Returns true if key was an RPM filter key (reply written). */
static bool cmd_set_rpm(const char *key, const char *valstr)
{
    if (!config_is_rpm_key(key)) return false;
    char *end = NULL;
    char msg[96];
    const float v = strtof(valstr, &end);
    if (end == valstr || *end != '\0' || !isfinite(v) || v != floorf(v)) { cli_write_str("set failed\r\n"); return true; }
    if (!config_rpm_value_valid(key, v)) {
        const char *rule = !strcmp(key, "rpm_filter_harmonics") ? "0..3"
                         : !strcmp(key, "rpm_filter_min_hz") ? "50..200"
                         : !strcmp(key, "rpm_filter_q_x100") ? "100..1000" : "even, 4..36";
        snprintf(msg, sizeof msg, "set failed: %s must be %s\r\n", key, rule);
        cli_write_str(msg);
        return true;
    }
    if (!config_set_key(key, v)) { cli_write_str("set failed\r\n"); return true; }
    float now = 0.f;
    (void)config_get_key(key, &now);
    snprintf(msg, sizeof msg, "ok %s=%.6g\r\n", key, (double)now);
    cli_write_str(msg);
    return true;
}

static void cmd_rpm_filter(void)
{
    char buf[400];
    char hz[RPM_FILTER_MOTORS][16];
    rpm_filter_status_t st;
    filters_sync_dt();
    const float fs = gyro_filter_sample_hz();
    /* The exact dt of the gyro path (1/fs could differ by an ulp and force a
     * full coefficient recompute here and again on the next gyro sample). */
    rpm_filter_gyro_status(&st, gyro_filter_dt());
    for (unsigned m = 0; m < RPM_FILTER_MOTORS; m++) {
        if (st.motor_valid[m] && isfinite(st.motor_hz[m]) && st.motor_hz[m] > 0.f)
            snprintf(hz[m], sizeof hz[m], "%lu", (unsigned long)(st.motor_hz[m] + 0.5f));
        else
            snprintf(hz[m], sizeof hz[m], "unavailable");
    }
    int n = snprintf(buf, sizeof buf,
        "rpm_filter_api: 1\r\n"
        "rpm_filter_active: %s\r\nrpm_filter_reason: %s\r\n"
        "rpm_filter_sample_hz: %lu\r\nrpm_filter_harmonics_active: %u\r\n"
        "rpm_filter_m1_hz: %s\r\nrpm_filter_m2_hz: %s\r\nrpm_filter_m3_hz: %s\r\nrpm_filter_m4_hz: %s\r\n"
        "rpm_filter_end: 1\r\n",
        st.reason == RPM_FILTER_OK ? "yes" : "no", rpm_filter_reason_name(st.reason),
        (unsigned long)(isfinite(fs) && fs > 0.f ? fs + 0.5f : 0.f), st.harmonics_active,
        hz[0], hz[1], hz[2], hz[3]);
    if (n < 0 || (size_t)n >= sizeof buf) { cli_write_str("rpm_filter response failed: overflow\r\n"); return; }
    cli_write_str(buf);
}
#endif
