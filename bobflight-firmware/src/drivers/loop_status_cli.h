/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_LOOP_STATUS_CLI_H
#define BOBFLIGHT_LOOP_STATUS_CLI_H
#include "sched/loop_rate_setting.h"
/* Private; included by cli.c after cli_write_str.
 * Frozen `status` contract agreed with the Configurator (do not rename):
 *   loop_target_hz: gyro_hz / pid_process_denom
 *   loop_actual_hz: PID cascade runs over the last closed ~1 s window, or the
 *                   literal `unavailable` until the first window closes
 *   loop_overruns:  since-boot cycles longer than the gyro period (the same
 *                   counter as `timing` cycle_overruns) */
static int loop_status_lines(char *buf, size_t n, uint64_t now)
{
    const scheduler_stats_t *s = scheduler_stats();
    uint32_t actual = 0;
    char actual_text[16] = "unavailable";
    if (scheduler_loop_actual_hz(now, &actual))
        snprintf(actual_text, sizeof actual_text, "%lu", (unsigned long)actual);
    return snprintf(buf, n, "loop_target_hz: %lu\r\nloop_actual_hz: %s\r\nloop_overruns: %llu\r\n",
                    (unsigned long)scheduler_loop_target_hz(), actual_text,
                    (unsigned long long)(s ? s->overruns : 0u));
}

/* Read-only loop-rate policy report: why the scheduler runs its current rate.
 * loop_rate_setting_hz is the (possibly unsaved) setting, boot_setting_hz the
 * value applied at boot; pending_reboot is 1 while they differ. profile is the
 * gyro/denom the boot setting asks for, active what actually runs. */
static void cmd_loop_rate(void)
{
    const loop_rate_t profile = loop_rate_requested_profile(), active = loop_rate_active();
    const gyro_diagnostics_t *g = gyro_diagnostics();
    char buf[480];
    int n = snprintf(buf, sizeof buf,
        "loop_rate_api: 1\r\nloop_rate_setting_hz: %lu\r\nloop_rate_boot_setting_hz: %lu\r\n"
        "loop_rate_pending_reboot: %u\r\n"
        "loop_rate_profile: %lu/%lu\r\nloop_rate_active: %lu/%lu\r\n"
        "loop_rate_reason: %s\r\nloop_rate_guard_level: %u\r\n"
        "loop_rate_gyro_odr_hz: %lu\r\nloop_rate_gyro_spi_hz: %lu\r\nloop_rate_end: 1\r\n",
        (unsigned long)loop_rate_setting_get(), (unsigned long)loop_rate_boot_setting_hz(),
        loop_rate_pending_reboot() ? 1u : 0u,
        (unsigned long)profile.gyro_hz, (unsigned long)profile.pid_denom,
        (unsigned long)active.gyro_hz, (unsigned long)active.pid_denom,
        loop_rate_reason(), loop_rate_guard_level(),
        (unsigned long)(g ? g->odr_hz : 0u), (unsigned long)(g ? g->spi_read_hz : 0u));
    if (n < 0 || (size_t)n >= sizeof buf) { cli_write_str("loop_rate response failed: overflow\r\n"); return; }
    cli_write_str(buf);
}
#endif
