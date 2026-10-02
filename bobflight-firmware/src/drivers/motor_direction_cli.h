/* Copyright 2026 Robert Leclercq — SPDX-License-Identifier: Apache-2.0 */
#ifndef BOBFLIGHT_MOTOR_DIRECTION_CLI_H
#define BOBFLIGHT_MOTOR_DIRECTION_CLI_H
#include "flight/arming.h"
#include "flight/config.h"
#include "flight/mixer.h"
#include "sched/tasks.h"
#include <stdio.h>
#include <string.h>
/* Private; included by cli.c (uses its cli_write_str).
 *
 * `motor_direction` (schema 10; frozen with the Configurator): tells the mixer
 * which way the props spin. It does NOT change the spin direction in the ESC.
 *   get motor_direction  ->  motor_direction=props-out|props-in
 * `set motor_direction <token>` replies, exactly:
 *   ok motor_direction=props-out|props-in
 *   set failed: armed                                       (existing line, every key)
 *   set failed: motor test running                          (motor_test, motor_pulse,
 *                                                            motor_seq or the receiver
 *                                                            switch bench active)
 *   set failed: motor_direction must be props-out or props-in
 * Accepted only disarmed with no motor test; applies at the next mixer call
 * (no reboot). Save to controller keeps it after reboot. Checked in this order.
 *
 * Read-only `mixer` report (framed; frozen: exactly these lines, in this order):
 *   mixer_api: 1
 *   mixer: quadx
 *   motor_direction: props-out|props-in      (what the mixer applies now)
 *   mixer_yaw_m1: -1|+1                      (sign on the PID yaw output, M1 rear-right)
 *   mixer_yaw_m2: -1|+1                      (M2 front-right)
 *   mixer_yaw_m3: -1|+1                      (M3 rear-left)
 *   mixer_yaw_m4: -1|+1                      (M4 front-left)
 *   mixer_end: 1
 */
#define MOTOR_DIRECTION_ARMED_LINE "set failed: armed"
#define MOTOR_DIRECTION_MOTOR_TEST_LINE "set failed: motor test running"
#define MOTOR_DIRECTION_INVALID_LINE "set failed: motor_direction must be props-out or props-in"

/* Returns true if key was motor_direction (reply written). */
static bool cmd_set_motor_direction(const char *key, const char *valstr)
{
    char msg[64];
    motor_direction_t d;
    if (!key || strcmp(key, "motor_direction") != 0) return false;
    /* cmd_set already refuses every key while armed; kept here so this
     * setter is safe on its own (same existing line). */
    if (arming_state() == ARM_ARMED) { cli_write_str(MOTOR_DIRECTION_ARMED_LINE "\r\n"); return true; }
    if (bench_motor_active()) { cli_write_str(MOTOR_DIRECTION_MOTOR_TEST_LINE "\r\n"); return true; }
    if (!config_motor_direction_parse(valstr, &d) || !config_set_motor_direction(d)) {
        cli_write_str(MOTOR_DIRECTION_INVALID_LINE "\r\n");
        return true;
    }
    snprintf(msg, sizeof msg, "ok motor_direction=%s\r\n", config_motor_direction_name(config_motor_direction()));
    cli_write_str(msg);
    return true;
}

/* Returns true if key was motor_direction (reply written). */
static bool cmd_get_motor_direction(const char *key)
{
    char msg[48];
    if (!key || strcmp(key, "motor_direction") != 0) return false;
    snprintf(msg, sizeof msg, "motor_direction=%s\r\n", config_motor_direction_name(config_motor_direction()));
    cli_write_str(msg);
    return true;
}

static void cmd_mixer(void)
{
    char buf[200];
    const int n = snprintf(buf, sizeof buf,
        "mixer_api: 1\r\nmixer: quadx\r\nmotor_direction: %s\r\n"
        "mixer_yaw_m1: %+d\r\nmixer_yaw_m2: %+d\r\nmixer_yaw_m3: %+d\r\nmixer_yaw_m4: %+d\r\n"
        "mixer_end: 1\r\n",
        mixer_yaw_direction() < 0.f ? "props-in" : "props-out",
        mixer_yaw_sign(0), mixer_yaw_sign(1), mixer_yaw_sign(2), mixer_yaw_sign(3));
    if (n < 0 || (size_t)n >= sizeof buf) cli_write_str("mixer failed: overflow\r\n");
    else cli_write_str(buf);
}
#endif
