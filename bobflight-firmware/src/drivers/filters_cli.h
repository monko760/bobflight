/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_FILTERS_CLI_H
#define BOBFLIGHT_FILTERS_CLI_H
#include "flight/filter.h"
#include <math.h>
/* Private; included by cli.c after cli_write_str.
 *
 * Manual gyro notch settings (schema 8; frozen with the Configurator):
 *   gyro_notch1_hz / gyro_notch2_hz               centre, 0 = off, else 20..1000
 *   gyro_notch1_cutoff_hz / gyro_notch2_cutoff_hz lower -3 dB edge, 0 < cutoff < centre
 * get/diff/dump/defaults/save follow gyro_lpf_hz (%.6g). `set` replies:
 *   ok gyro_notch1_hz=<v>
 *   set failed: gyro_notch1_hz must be 0 or 20..1000
 *   set failed: gyro_notch1_hz needs 0 < gyro_notch1_cutoff_hz < gyro_notch1_hz (set the cutoff first)
 *   set failed: gyro_notch1_hz must be below <limit> Hz at the running <fs> Hz loop rate
 *   set failed: gyro_notch1_cutoff_hz must be > 0 and < gyro_notch1_hz
 *   set failed: gyro_notch1_cutoff_hz must be >= 0 and < 1000 while gyro_notch1_hz is 0
 *   set failed          (not a number)          set failed: armed
 *
 * Read-only `filters` report (framed):
 *   filters_api: 1
 *   filters_sample_hz: <actual gyro-filter rate = PID cadence, integer Hz>
 *   gyro_notch1_active: yes|no
 *   gyro_notch1_reason: off|ok|above-nyquist|invalid
 *   gyro_notch2_active: yes|no
 *   gyro_notch2_reason: off|ok|above-nyquist|invalid
 *   filters_end: 1
 */

/* Same filter dt the PID cascade sets every cycle (loop_filter():
 * pid_process_denom / gyro_hz of the running scheduler), so a report or a
 * `set` issued before the next cascade still sees the actual rate. */
static void filters_sync_dt(void)
{
    const scheduler_stats_t *st = scheduler_stats();
    if (st && st->gyro_hz > 0u && st->pid_process_denom > 0u)
        gyro_filter_set_dt((float)st->pid_process_denom / (float)st->gyro_hz);
}

/* 1 or 2 for a notch key, 0 otherwise; *center tells centre vs cutoff. */
static unsigned notch_cli_key(const char *key, bool *center)
{
    if (strncmp(key, "gyro_notch", 10) != 0 || (key[10] != '1' && key[10] != '2')) return 0;
    if (strcmp(key + 11, "_hz") == 0) { *center = true; return (unsigned)(key[10] - '0'); }
    if (strcmp(key + 11, "_cutoff_hz") == 0) { *center = false; return (unsigned)(key[10] - '0'); }
    return 0;
}

/* Returns true if key was a notch key (reply written). */
static bool cmd_set_notch(const char *key, const char *valstr)
{
    bool center = false;
    const unsigned idx = notch_cli_key(key, &center);
    if (!idx) return false;
    char *end = NULL;
    char msg[160];
    const float v = strtof(valstr, &end);
    if (end == valstr || *end != '\0' || !isfinite(v)) { cli_write_str("set failed\r\n"); return true; }
    char ck[32], fk[32];
    snprintf(ck, sizeof ck, "gyro_notch%u_hz", idx);
    snprintf(fk, sizeof fk, "gyro_notch%u_cutoff_hz", idx);
    float cur_c = 0.f, cur_f = 0.f;
    (void)config_get_key(ck, &cur_c);
    (void)config_get_key(fk, &cur_f);
    if (center) {
        if (v != 0.f && (v < FILTER_NOTCH_CENTER_MIN_HZ || v > FILTER_NOTCH_CENTER_MAX_HZ)) {
            snprintf(msg, sizeof msg, "set failed: %s must be 0 or 20..1000\r\n", ck);
            cli_write_str(msg); return true;
        }
        if (v != 0.f && !(cur_f > 0.f && cur_f < v)) {
            snprintf(msg, sizeof msg, "set failed: %s needs 0 < %s < %s (set the cutoff first)\r\n", ck, fk, ck);
            cli_write_str(msg); return true;
        }
        filters_sync_dt();
        const float fs = gyro_filter_sample_hz();
        const float limit = filter_notch_center_limit_hz(fs);
        if (v != 0.f && !(v < limit)) {
            snprintf(msg, sizeof msg, "set failed: %s must be below %.6g Hz at the running %.6g Hz loop rate\r\n",
                     ck, (double)limit, (double)fs);
            cli_write_str(msg); return true;
        }
    } else if (!config_gyro_notch_pair_valid(cur_c, v)) {
        if (cur_c != 0.f) snprintf(msg, sizeof msg, "set failed: %s must be > 0 and < %s\r\n", fk, ck);
        else snprintf(msg, sizeof msg, "set failed: %s must be >= 0 and < 1000 while %s is 0\r\n", fk, ck);
        cli_write_str(msg); return true;
    }
    if (!config_set_key(key, v)) { cli_write_str("set failed\r\n"); return true; }
    float now = 0.f;
    (void)config_get_key(key, &now);
    snprintf(msg, sizeof msg, "ok %s=%.6g\r\n", key, (double)now);
    cli_write_str(msg);
    return true;
}

static void cmd_filters(void)
{
    char buf[256];
    bool a1 = false, a2 = false;
    const char *r1 = "invalid", *r2 = "invalid";
    filters_sync_dt();
    (void)gyro_notch_status(1, &a1, &r1);
    (void)gyro_notch_status(2, &a2, &r2);
    const float fs = gyro_filter_sample_hz();
    int n = snprintf(buf, sizeof buf,
        "filters_api: 1\r\nfilters_sample_hz: %lu\r\n"
        "gyro_notch1_active: %s\r\ngyro_notch1_reason: %s\r\n"
        "gyro_notch2_active: %s\r\ngyro_notch2_reason: %s\r\nfilters_end: 1\r\n",
        (unsigned long)(isfinite(fs) && fs > 0.f ? fs + 0.5f : 0.f),
        a1 ? "yes" : "no", r1, a2 ? "yes" : "no", r2);
    if (n < 0 || (size_t)n >= sizeof buf) { cli_write_str("filters response failed: overflow\r\n"); return; }
    cli_write_str(buf);
}
#endif
