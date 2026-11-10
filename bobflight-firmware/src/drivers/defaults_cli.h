/*
 * Copyright 2026 Robert Leclercq
 * SPDX-License-Identifier: Apache-2.0
 */
#ifndef BOBFLIGHT_DEFAULTS_CLI_H
#define BOBFLIGHT_DEFAULTS_CLI_H
/* D1 scoped defaults (frozen with the Config Lead):
 *   defaults pid|rates|filters
 *   -> defaults_group: <g>
 *      defaults_key: <key>=<value>   one per key, `get` format
 *      defaults_end: <g> <count>     count == number of defaults_key lines
 * Refusals are one line and change nothing (the Blackbox refusal runs earlier
 * in handle_line):
 *   defaults_error: armed | bench_active | calibration_active
 *   defaults_error: unknown_group
 *   defaults_error: group_required pid|rates|filters   (bare `defaults`)
 * RAM only, no auto-save. Only the group's keys move: align_*, motor_direction,
 * motor_poles, loop rate, DShot, power, ports, map, modes and accelerometer
 * calibration are never touched, so a later Save keeps the calibration. */
#include <string.h>
#include "flight/config.h"
#include "flight/arming.h"
#include "drivers/gyro.h"
#include "drivers/setting_format.h"
#include "sched/tasks.h"

static bool cmd_defaults(const char *line)
{
    const char *group;
    const char *const *keys;
    size_t count = 0;
    char buf[96];
    if (strcmp(line, "defaults") == 0) group = NULL;
    else if (strncmp(line, "defaults ", 9) == 0) group = line + 9;
    else return false;
    if (arming_state() == ARM_ARMED) { cli_write_str("defaults_error: armed\r\n"); return true; }
    if (bench_motor_active()) { cli_write_str("defaults_error: bench_active\r\n"); return true; }
    if (gyro_manual_calibration_active()) { cli_write_str("defaults_error: calibration_active\r\n"); return true; }
    if (!group) { cli_write_str("defaults_error: group_required pid|rates|filters\r\n"); return true; }
    keys = config_defaults_group_keys(group, &count);
    if (!keys || !config_defaults_group(group)) { cli_write_str("defaults_error: unknown_group\r\n"); return true; }
    snprintf(buf, sizeof(buf), "defaults_group: %s\r\n", group);
    cli_write_str(buf);
    for (size_t i = 0; i < count; i++) {
        float v = 0.f;
        (void)config_get_key(keys[i], &v);
        setting_format_line(buf, sizeof(buf), "defaults_key: ", keys[i], v);
        cli_write_str(buf);
    }
    snprintf(buf, sizeof(buf), "defaults_end: %s %u\r\n", group, (unsigned)count);
    cli_write_str(buf);
    return true;
}
#endif
